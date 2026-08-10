-- Scheduling for the notification queue, plus the resident's way out of it.
--
-- pg_cron is already proven on this project -- the `civicpulse-assign-sweep`
-- job from 0002 has been running since it was created -- so unlike 0002 this
-- is not wrapped in an exception-swallowing DO block. If scheduling fails here
-- the migration should fail loudly rather than leave a queue nobody drains.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Dispatch
--
-- The URL and the service-role key live in Vault rather than inline in the
-- cron command, because `cron.job` stores its command as plain text and this
-- file is in git. Create them once, by hand, from the SQL editor:
--
--   select vault.create_secret(
--     'https://<project-ref>.supabase.co/functions/v1/send-notifications',
--     'notifications_function_url', 'CivicPulse notification sender');
--   select vault.create_secret(
--     '<service-role-key>', 'notifications_service_key', 'CivicPulse notification sender');
--
-- Until those exist this warns once a minute and sends nothing, which is the
-- right failure: visible, and harmless.
-- ---------------------------------------------------------------------------
create or replace function dispatch_notifications() returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_key text;
  v_pending int;
  v_request_id bigint;
begin
  -- Waking the edge function 1,440 times a day to find an empty queue costs
  -- invocations for nothing. The queue is almost always empty.
  select count(*) into v_pending from notifications where status = 'queued';
  if v_pending = 0 then
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'notifications_function_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'notifications_service_key';

  if v_url is null or v_key is null then
    raise warning 'dispatch_notifications: vault secrets not set, % notification(s) waiting', v_pending;
    return null;
  end if;

  -- Fire and forget: pg_net is async and the response lands in net._http_response,
  -- which nothing reads. That is deliberate -- the function reports what it did
  -- by updating the queue rows themselves, so the HTTP reply carries no
  -- information we need. A post that never arrives leaves rows 'queued' and the
  -- next tick retries; one that dies mid-send leaves them 'sending' and
  -- requeue_stuck_notifications picks them up.
  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function dispatch_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'civicpulse-send-notifications') then
    perform cron.unschedule('civicpulse-send-notifications');
  end if;
  if exists (select 1 from cron.job where jobname = 'civicpulse-requeue-stuck-notifications') then
    perform cron.unschedule('civicpulse-requeue-stuck-notifications');
  end if;
end;
$$;

select cron.schedule(
  'civicpulse-send-notifications',
  '* * * * *',
  'select dispatch_notifications()'
);

-- Without this, a worker that dies between sending and reporting strands its
-- rows in 'sending' for ever and nothing notices.
select cron.schedule(
  'civicpulse-requeue-stuck-notifications',
  '*/15 * * * *',
  'select requeue_stuck_notifications()'
);

-- ---------------------------------------------------------------------------
-- Unsubscribe
--
-- Not optional. Mail a resident with no working way out and the sending address
-- earns a spam reputation it will not recover from. The token is the whole
-- credential -- it is unguessable, scoped to one subscription, and grants
-- nothing except the ability to stop that subscription.
-- ---------------------------------------------------------------------------
create or replace function unsubscribe_from_ticket(p_token uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_subscriber_id uuid;
  v_issue_id uuid;
  v_ticket text;
begin
  update issue_subscribers
     set unsubscribed_at = coalesce(unsubscribed_at, now())
   where unsubscribe_token = p_token
  returning id, issue_id into v_subscriber_id, v_issue_id;

  if v_subscriber_id is null then
    raise exception 'That unsubscribe link is not valid';
  end if;

  -- Anything already queued for them must not go out now.
  update notifications
     set status = 'skipped', last_error = 'subscriber unsubscribed'
   where subscriber_id = v_subscriber_id
     and status = 'queued';

  select ticket_number into v_ticket from issues where id = v_issue_id;
  return v_ticket;
end;
$$;

grant execute on function unsubscribe_from_ticket(uuid) to anon, authenticated;
