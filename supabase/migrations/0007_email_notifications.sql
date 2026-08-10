-- Email updates for residents who left an address instead of staying anonymous.
--
-- This migration does the database half only: it decides *what* should be sent
-- and queues it. Nothing here sends anything -- draining the queue is n8n's job
-- (see `claim_notifications` at the bottom). Applying this on its own is safe:
-- rows accumulate with status 'queued' and no mail leaves the building.
--
-- Two pre-existing security holes are closed first, because both of them turn
-- from "log noise" into "real incident" the moment a sender is attached.

-- ---------------------------------------------------------------------------
-- 1. Stop handing every resident's contact details to anyone with the anon key
--
-- `issues_select_public` is `using (true)` (0001) and was never narrowed, while
-- TrackIssue does `select('*')`. Between them, anybody holding the anon key --
-- which ships in the client bundle -- could dump reporter_contact for every
-- ticket ever filed. RLS cannot filter columns, so this is a column-level GRANT.
--
-- Withheld from `anon`: reporter_contact and reporter_channel (personal data,
-- and whether someone reported anonymously is itself worth not publishing) and
-- image_signature (the dedup perceptual hash -- internal, and publishing it
-- would let someone probe what has already been reported).
--
-- INSERT is deliberately left alone: a resident must still be able to *write*
-- their own contact details when filing. Column grants are per-privilege, so
-- write-but-not-read is exactly expressible here.
--
-- Staff are unaffected -- they authenticate, so they hit these tables as
-- `authenticated`, which keeps its full grant. Every resident-facing page is
-- anonymous; every staff page is not.
-- ---------------------------------------------------------------------------
revoke select on issues from anon;

grant select (
  id, ticket_number, photo_url, comment, landmark, latitude, longitude,
  pincode, area, city, state, issue_type, department_id, priority,
  ai_summary, ai_confidence, status, assigned_to, duplicate_of, reopen_count,
  resolution_photo_url, resolution_comment, resolved_at, closed_at,
  rating, rating_comment, created_at, updated_at
) on issues to anon;

-- ---------------------------------------------------------------------------
-- 2. Close the open relay
--
-- 0003 opened `notifications` to public INSERT to fix silent logging failures.
-- That was harmless while the table was a dead-end log. Once a worker drains it
-- and sends mail, `with check (true)` means anyone with the anon key can insert
-- {recipient: <victim>, message: <anything>} and have CivicPulse's own domain
-- deliver it. Inserts now come only from the SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------
drop policy if exists notifications_insert_public on notifications;
revoke insert, update, delete on notifications from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Subscribers
--
-- A separate table rather than leaning on issues.reporter_contact, because of
-- the dedup path: when a report is merged into an existing ticket no issue row
-- is created, so the second resident's address has nowhere to live. They gave
-- us an email and would have heard nothing ever again. One issue, many
-- followers -- that is a join table, not a column.
--
-- Locked down hard: no anon grant at all. Residents subscribe through
-- `subscribe_to_ticket()` and leave through their unsubscribe token. Nobody can
-- enumerate who is following what.
-- ---------------------------------------------------------------------------
create table if not exists issue_subscribers (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  channel text not null default 'email' check (channel in ('email', 'sms', 'telegram')),
  contact text not null,
  unsubscribe_token uuid not null default gen_random_uuid(),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (issue_id, contact)
);

create index if not exists issue_subscribers_issue_idx on issue_subscribers (issue_id);
create unique index if not exists issue_subscribers_token_idx
  on issue_subscribers (unsubscribe_token);

alter table issue_subscribers enable row level security;

-- New tables inherit `grant all to anon, authenticated` from Supabase's default
-- privileges, so this has to be taken away explicitly rather than assumed off.
revoke all on issue_subscribers from anon, authenticated;
grant select on issue_subscribers to authenticated;

-- Staff can see who is following a ticket; nobody else reads this table, and
-- nothing writes to it except the SECURITY DEFINER functions below.
create policy issue_subscribers_select_staff on issue_subscribers for select
  using (exists (select 1 from profiles p where p.id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Notifications becomes a work queue
--
-- `message` gave way to `event` + `payload`: Postgres decides that something
-- happened and hands over the facts, the worker renders the sentence. That is
-- what lets email copy be edited without a database migration. `message` is
-- kept (nullable) so the rows already logged stay readable.
-- ---------------------------------------------------------------------------
alter table notifications
  alter column message drop not null;

alter table notifications
  add column if not exists event text,
  add column if not exists payload jsonb,
  add column if not exists subscriber_id uuid references issue_subscribers (id) on delete set null,
  add column if not exists attempts int not null default 0,
  add column if not exists last_error text,
  add column if not exists claimed_at timestamptz,
  add column if not exists sent_at timestamptz;

-- status: 'logged' (pre-existing rows) | 'queued' | 'sending' | 'sent' | 'failed'
-- Deliberately no check constraint, matching the original table: adding channels
-- later shouldn't need a migration to widen an enum.

create index if not exists notifications_queue_idx
  on notifications (status, created_at)
  where status in ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- 5. Enqueue
--
-- One helper, called from the triggers and from subscribe_to_ticket. Fans a
-- single event out to every active subscriber on the ticket.
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
      and channel = 'email'
      -- null means "everyone following"; a value targets one new subscriber.
      and (p_subscriber_id is null or id = p_subscriber_id)
  loop
    insert into notifications (
      issue_id, channel, recipient, status, event, subscriber_id, payload
    )
    values (
      p_issue_id,
      'email',
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
-- 6. Triggers -- the whole reason this lives in Postgres
--
-- CLAUDE.md already records the hazard: "if you add a status-changing code path
-- you must write the history row yourself or the audit trail silently goes
-- stale." Email has the same failure mode and a worse consequence -- a missing
-- audit row is invisible, a missing email is a resident who thinks they were
-- ignored. Today only 2 of ~8 status-change paths write a notification row.
--
-- A trigger covers all of them at once, including the three the frontend cannot
-- see: rate_issue()'s reopen/close, sweep_unassigned_issues(), and the
-- deactivation reassignment in 0004.
-- ---------------------------------------------------------------------------

-- The reporter becomes the first subscriber. Done here rather than in the
-- client so that every insert path enrols the reporter, for the same reason
-- assignment is a trigger and not frontend code.
create or replace function issues_enrol_reporter() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_subscriber_id uuid;
begin
  if new.reporter_channel = 'email' and coalesce(trim(new.reporter_contact), '') <> '' then
    insert into issue_subscribers (issue_id, channel, contact)
    values (new.id, 'email', lower(trim(new.reporter_contact)))
    on conflict (issue_id, contact) do nothing
    returning id into v_subscriber_id;

    if v_subscriber_id is not null then
      perform enqueue_issue_notifications(new.id, 'ticket_created', v_subscriber_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists issues_enrol_reporter_trigger on issues;
create trigger issues_enrol_reporter_trigger
  after insert on issues
  for each row execute function issues_enrol_reporter();

create or replace function issues_notify_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform enqueue_issue_notifications(new.id, 'status_changed', null, old.status);
  return null;
end;
$$;

drop trigger if exists issues_notify_status_trigger on issues;
create trigger issues_notify_status_trigger
  after update of status on issues
  for each row
  -- `update of status` still fires when the column is written with the same
  -- value; this is what makes it fire only on a real transition.
  when (old.status is distinct from new.status)
  execute function issues_notify_status_change();

-- ---------------------------------------------------------------------------
-- 7. Resident-facing RPC: follow a ticket
--
-- Used by the dedup path, where the resident's report was merged and no issue
-- row of their own exists. SECURITY DEFINER because `issue_subscribers` grants
-- anon nothing at all.
-- ---------------------------------------------------------------------------
create or replace function subscribe_to_ticket(
  p_ticket_number text,
  p_contact text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_issue issues%rowtype;
  v_subscriber_id uuid;
  v_followers int;
  v_max_followers constant int := 50;
begin
  if coalesce(trim(p_contact), '') = '' then
    raise exception 'An email address is required';
  end if;

  -- Shape check only. The real validation is whether the mail arrives, and
  -- over-strict address regexes reject more valid addresses than invalid ones.
  if trim(p_contact) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address';
  end if;

  select * into v_issue from issues where ticket_number = upper(trim(p_ticket_number));
  if v_issue.id is null then
    raise exception 'Ticket % not found', p_ticket_number;
  end if;

  -- Anyone can call this with any address, so cap the fan-out. Without a cap a
  -- single ticket could be turned into a mailing list aimed at someone else.
  -- Rate limiting per caller belongs in front of this and is not built yet.
  select count(*) into v_followers from issue_subscribers where issue_id = v_issue.id;
  if v_followers >= v_max_followers then
    raise exception 'This ticket already has the maximum number of followers';
  end if;

  insert into issue_subscribers (issue_id, channel, contact)
  values (v_issue.id, 'email', lower(trim(p_contact)))
  on conflict (issue_id, contact) do nothing
  returning id into v_subscriber_id;

  -- Already following: succeed quietly rather than sending a second welcome.
  if v_subscriber_id is null then
    return null;
  end if;

  perform enqueue_issue_notifications(v_issue.id, 'ticket_followed', v_subscriber_id);
  return v_subscriber_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Queue plumbing for the worker
--
-- The claim is a single statement on purpose. n8n has no transaction spanning
-- nodes, so a "select queued rows" node followed by a "mark them sending" node
-- lets two overlapping runs grab the same row and email the resident twice.
-- `for update skip locked` inside one UPDATE makes that impossible.
-- ---------------------------------------------------------------------------
create or replace function claim_notifications(p_limit int default 20)
returns setof notifications
language sql security definer set search_path = public as $$
  with claimed as (
    select id from notifications
    where status = 'queued'
    order by created_at
    limit greatest(1, least(p_limit, 200))
    for update skip locked
  )
  update notifications n
     set status = 'sending',
         claimed_at = now(),
         -- Counted at claim time, not on failure: a worker that dies mid-send
         -- still burns an attempt, so a row that reliably kills the worker
         -- cannot retry for ever.
         attempts = n.attempts + 1
    from claimed c
   where n.id = c.id
  returning n.*;
$$;

create or replace function mark_notification_sent(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update notifications
     set status = 'sent', sent_at = now(), last_error = null
   where id = p_id;
$$;

create or replace function mark_notification_failed(p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_max_attempts constant int := 5;
begin
  update notifications
     set status = case when attempts >= v_max_attempts then 'failed' else 'queued' end,
         last_error = left(coalesce(p_error, 'unknown error'), 1000),
         claimed_at = null
   where id = p_id;
end;
$$;

-- If the worker dies between sending and reporting, the row is stranded in
-- 'sending' for ever. Nothing else notices, so something has to sweep.
create or replace function requeue_stuck_notifications(p_older_than interval default interval '10 minutes')
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_max_attempts constant int := 5;
begin
  update notifications
     set status = case when attempts >= v_max_attempts then 'failed' else 'queued' end,
         claimed_at = null,
         last_error = coalesce(last_error, 'worker did not report back')
   where status = 'sending'
     and claimed_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Who may call what
--
-- Functions are executable by PUBLIC by default, which for SECURITY DEFINER
-- queue plumbing would mean any anonymous visitor could claim and discard the
-- mail queue. Only `subscribe_to_ticket` is resident-facing.
-- ---------------------------------------------------------------------------
revoke execute on function enqueue_issue_notifications(uuid, text, uuid, text) from public;
revoke execute on function claim_notifications(int) from public;
revoke execute on function mark_notification_sent(uuid) from public;
revoke execute on function mark_notification_failed(uuid, text) from public;
revoke execute on function requeue_stuck_notifications(interval) from public;

grant execute on function subscribe_to_ticket(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Backfill
--
-- Everyone who already chose "Email" when reporting asked to be contacted, so
-- they are enrolled on their own ticket. No notification is queued for these --
-- they are subscribed going forward, not sent a retrospective welcome.
-- ---------------------------------------------------------------------------
insert into issue_subscribers (issue_id, channel, contact)
select id, 'email', lower(trim(reporter_contact))
  from issues
 where reporter_channel = 'email'
   and coalesce(trim(reporter_contact), '') <> ''
on conflict (issue_id, contact) do nothing;
