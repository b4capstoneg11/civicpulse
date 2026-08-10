-- Telegram as a second delivery channel.
--
-- The database half only. Nothing here sends anything, and nothing here changes
-- what an email subscriber receives.
--
-- Telegram works differently from email in one way that shapes all of this: a
-- bot cannot message someone by username or phone number, only by a chat_id it
-- learns when that person messages the bot first. So a resident cannot be
-- enrolled at the moment they file a report the way an email reporter is. They
-- are handed a single-use token, they open the bot, and the webhook trades the
-- token for a subscription.
--
-- `issue_subscribers.channel` and `notifications.channel` already permit
-- 'telegram' (0007), so no table is altered.

-- ---------------------------------------------------------------------------
-- 1. Link tokens
--
-- Telegram deep links look like t.me/<bot>?start=<payload>, and the payload is
-- capped at 64 characters from [A-Za-z0-9_-] -- hence base64url rather than a
-- plain uuid text, which would spend 36 characters to carry 16 bytes.
--
-- A token confers exactly one thing: "send updates about a ticket to whoever
-- redeems this". It is single-use and short-lived, and issuing one requires
-- already knowing the ticket number.
-- ---------------------------------------------------------------------------
create table if not exists telegram_link_tokens (
  token text primary key,
  issue_id uuid not null references issues (id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index if not exists telegram_link_tokens_issue_idx on telegram_link_tokens (issue_id);

alter table telegram_link_tokens enable row level security;

-- New tables inherit `grant all to anon, authenticated` from Supabase's default
-- privileges, so it has to be taken away rather than assumed absent. No policy
-- is added: nothing reaches this table except the SECURITY DEFINER functions.
revoke all on telegram_link_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Issue a token
--
-- Called from the confirmation screen after a report is filed. Anonymous
-- callers are the normal case -- a resident who chose "Stay Anonymous" can take
-- Telegram updates without giving us anything identifying, which is the one
-- channel where that is true.
-- ---------------------------------------------------------------------------
create or replace function create_telegram_link_token(p_ticket_number text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_issue_id uuid;
  v_token text;
  v_outstanding int;
  v_max_outstanding constant int := 20;
begin
  select id into v_issue_id
    from issues where ticket_number = upper(trim(p_ticket_number));

  if v_issue_id is null then
    raise exception 'Ticket % not found', p_ticket_number;
  end if;

  -- Opportunistic cleanup, so expired rows do not need their own cron job.
  delete from telegram_link_tokens
   where created_at < now() - interval '24 hours';

  select count(*) into v_outstanding
    from telegram_link_tokens
   where issue_id = v_issue_id and used_at is null;

  if v_outstanding >= v_max_outstanding then
    raise exception 'Too many outstanding Telegram links for this ticket';
  end if;

  -- 18 bytes -> exactly 24 base64 characters, no padding to strip.
  v_token := replace(replace(encode(gen_random_bytes(18), 'base64'), '+', '-'), '/', '_');

  insert into telegram_link_tokens (token, issue_id) values (v_token, v_issue_id);
  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Redeem a token
--
-- Called by the telegram-webhook function under the service role.
--
-- Idempotent on purpose: Telegram retries a webhook it believes failed, and the
-- same /start can arrive more than once. A second redemption of a spent token
-- by the same chat returns the ticket number again rather than erroring, so the
-- bot's reply is identical and the resident sees one coherent response.
--
-- No notification is queued here. The bot answers in the chat immediately, so
-- queueing a "you are now following" message would deliver the same thing twice.
-- ---------------------------------------------------------------------------
create or replace function telegram_subscribe(p_token text, p_chat_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_issue_id uuid;
  v_used_at timestamptz;
  v_created_at timestamptz;
begin
  if coalesce(trim(p_chat_id), '') = '' then
    raise exception 'A chat id is required';
  end if;

  select issue_id, used_at, created_at
    into v_issue_id, v_used_at, v_created_at
    from telegram_link_tokens where token = p_token;

  if v_issue_id is null then
    return null;                                   -- unknown token
  end if;

  if v_created_at < now() - interval '24 hours' then
    return null;                                   -- expired
  end if;

  -- Already redeemed: only the chat that redeemed it may replay it.
  if v_used_at is not null
     and not exists (
       select 1 from issue_subscribers
        where issue_id = v_issue_id and contact = trim(p_chat_id) and channel = 'telegram'
     )
  then
    return null;
  end if;

  update telegram_link_tokens
     set used_at = coalesce(used_at, now())
   where token = p_token;

  insert into issue_subscribers (issue_id, channel, contact)
  values (v_issue_id, 'telegram', trim(p_chat_id))
  on conflict (issue_id, contact) do update
     set unsubscribed_at = null;                   -- re-following after a /stop

  return (select ticket_number from issues where id = v_issue_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. /stop
--
-- One chat may follow several tickets, so this unsubscribes from all of them
-- and returns their numbers for the bot to name in its reply.
-- ---------------------------------------------------------------------------
create or replace function telegram_unsubscribe_all(p_chat_id text)
returns setof text
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  -- Collected first so the reply names exactly what this call stopped, rather
  -- than everything the chat has ever unsubscribed from.
  select array_agg(id) into v_ids
    from issue_subscribers
   where channel = 'telegram'
     and contact = trim(p_chat_id)
     and unsubscribed_at is null;

  if v_ids is null then
    return;                        -- following nothing; the bot says so
  end if;

  update issue_subscribers set unsubscribed_at = now() where id = any (v_ids);

  -- Anything already queued for this chat must not go out now.
  update notifications
     set status = 'skipped', last_error = 'subscriber unsubscribed'
   where subscriber_id = any (v_ids)
     and status = 'queued';

  return query
    select i.ticket_number
      from issue_subscribers s
      join issues i on i.id = s.issue_id
     where s.id = any (v_ids)
     order by i.ticket_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Make the fan-out channel-aware
--
-- The one change in this migration to something already in service. 0007 hard-
-- coded 'email' in both the subscriber filter and the inserted row, because
-- email was the only channel that could deliver. The body is otherwise
-- identical, and an email subscriber produces exactly the same row as before --
-- the channel is now read from the subscriber instead of being assumed.
-- ---------------------------------------------------------------------------
create or replace function enqueue_issue_notifications(
  p_issue_id uuid,
  p_event text,
  p_subscriber_id uuid default null,
  p_previous_status text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_issue issues%rowtype;
  v_department text;
  v_subscriber record;
  v_count int := 0;
begin
  select * into v_issue from issues where id = p_issue_id;
  if v_issue.id is null then
    return 0;
  end if;

  select name into v_department from departments where id = v_issue.department_id;

  for v_subscriber in
    select * from issue_subscribers
    where issue_id = p_issue_id
      and unsubscribed_at is null
      -- null means "everyone following"; a value targets one new subscriber.
      and (p_subscriber_id is null or id = p_subscriber_id)
  loop
    insert into notifications (
      issue_id, channel, recipient, status, event, subscriber_id, payload
    )
    values (
      p_issue_id,
      v_subscriber.channel,
      v_subscriber.contact,
      'queued',
      p_event,
      v_subscriber.id,
      jsonb_build_object(
        'ticket_number', v_issue.ticket_number,
        'status', v_issue.status,
        'previous_status', p_previous_status,
        'priority', v_issue.priority,
        'issue_type', v_issue.issue_type,
        'department', v_department,
        'comment', v_issue.comment,
        'landmark', v_issue.landmark,
        'area', v_issue.area,
        'city', v_issue.city,
        'resolution_comment', v_issue.resolution_comment,
        'resolution_photo_url', v_issue.resolution_photo_url,
        'rating', v_issue.rating,
        'reported_at', v_issue.created_at,
        'unsubscribe_token', v_subscriber.unsubscribe_token
      )
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
--
-- 0008 set the schema default to revoke EXECUTE from anon for new functions,
-- but `authenticated` still receives it automatically, so every function below
-- is named explicitly rather than trusted to the default. Only token issuance
-- is resident-facing; redemption and /stop belong to the webhook alone.
-- ---------------------------------------------------------------------------
revoke execute on function create_telegram_link_token(text) from public, anon, authenticated;
revoke execute on function telegram_subscribe(text, text) from public, anon, authenticated;
revoke execute on function telegram_unsubscribe_all(text) from public, anon, authenticated;
revoke execute on function enqueue_issue_notifications(uuid, text, uuid, text)
  from public, anon, authenticated;

grant execute on function create_telegram_link_token(text) to anon, authenticated;
