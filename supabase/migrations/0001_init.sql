-- CivicPulse core schema (Phase 1: report -> AI triage -> dedup -> Kanban -> closure/rating)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
create table departments (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null
);

insert into departments (slug, name) values
  ('roads', 'Roads & Potholes'),
  ('electrical', 'Streetlights & Electrical'),
  ('sanitation', 'Sanitation & Garbage'),
  ('water', 'Water Supply & Leakage'),
  ('public_works', 'Public Works & Infrastructure'),
  ('other', 'General / Other');

-- ---------------------------------------------------------------------------
-- Staff profiles (admin / department_user), one row per auth.users id
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin', 'department_user')),
  department_id uuid references departments (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Issues (tickets)
-- ---------------------------------------------------------------------------
create sequence issue_ticket_seq;

create table issues (
  id uuid primary key default gen_random_uuid(),
  ticket_number text unique not null default ('CP-' || lpad(nextval('issue_ticket_seq')::text, 6, '0')),

  -- reporter
  reporter_channel text not null check (reporter_channel in ('phone', 'email', 'anonymous')),
  reporter_contact text,

  -- submission
  photo_url text not null,
  comment text not null,
  landmark text,
  latitude double precision not null,
  longitude double precision not null,
  pincode text,
  area text,
  city text,
  state text,
  image_signature text not null,

  -- AI classification
  issue_type text not null check (
    issue_type in ('pothole', 'streetlight', 'garbage', 'water_leakage', 'damaged_infrastructure', 'other')
  ),
  department_id uuid not null references departments (id),
  priority text not null check (priority in ('low', 'medium', 'high')),
  ai_summary text,
  ai_confidence real,

  -- lifecycle
  status text not null default 'assigned' check (
    status in ('created', 'assigned', 'in_progress', 'resolved', 'closed', 'reopened')
  ),
  assigned_to uuid references profiles (id),
  duplicate_of uuid references issues (id),
  reopen_count int not null default 0,

  -- resolution
  resolution_photo_url text,
  resolution_comment text,
  resolved_at timestamptz,
  closed_at timestamptz,
  rating int check (rating between 1 and 5),
  rating_comment text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index issues_area_type_idx on issues (area, issue_type, status);
create index issues_status_idx on issues (status);
create index issues_department_idx on issues (department_id);

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger issues_set_updated_at
  before update on issues
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Status history / audit trail
-- ---------------------------------------------------------------------------
create table issue_status_history (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  status text not null,
  note text,
  actor text not null, -- 'ai' | 'resident' | 'staff:<name>'
  created_at timestamptz not null default now()
);

create index issue_status_history_issue_idx on issue_status_history (issue_id, created_at);

-- ---------------------------------------------------------------------------
-- Notifications (stub/log only for Phase 1 -- no real email/SMS/Telegram send)
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'telegram')),
  recipient text,
  message text not null,
  status text not null default 'logged',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table departments enable row level security;
alter table profiles enable row level security;
alter table issues enable row level security;
alter table issue_status_history enable row level security;
alter table notifications enable row level security;

create policy departments_select_all on departments for select using (true);

create policy profiles_select_all on profiles for select using (auth.role() = 'authenticated');

create policy issues_select_public on issues for select using (true);
create policy issues_insert_public on issues for insert with check (true);

create policy issues_update_staff on issues for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and (p.role = 'admin' or p.department_id = issues.department_id)
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and (p.role = 'admin' or p.department_id = issues.department_id)
    )
  );

create policy history_select_public on issue_status_history for select using (true);
create policy history_insert_public on issue_status_history for insert with check (true);

create policy notifications_select_staff on notifications for select
  using (exists (select 1 from profiles p where p.id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage: public bucket for issue + resolution photos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('issue-photos', 'issue-photos', true)
on conflict (id) do nothing;

create policy issue_photos_public_read on storage.objects
  for select using (bucket_id = 'issue-photos');

create policy issue_photos_public_upload on storage.objects
  for insert with check (bucket_id = 'issue-photos');

-- ---------------------------------------------------------------------------
-- RPC: resident submits a rating after resolution; auto-reopens on a poor rating
-- ---------------------------------------------------------------------------
create or replace function rate_issue(
  p_ticket_number text,
  p_rating int,
  p_rating_comment text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issue issues%rowtype;
  v_max_reopens constant int := 2;
begin
  select * into v_issue from issues where ticket_number = p_ticket_number;

  if v_issue.id is null then
    raise exception 'Ticket % not found', p_ticket_number;
  end if;

  if v_issue.status not in ('resolved', 'closed') then
    raise exception 'Ticket % is not yet resolved', p_ticket_number;
  end if;

  update issues
    set rating = p_rating,
        rating_comment = p_rating_comment,
        status = case
          when p_rating <= 2 and v_issue.reopen_count < v_max_reopens then 'reopened'
          when p_rating <= 2 then 'assigned' -- escalate: still routed back, but audit trail flags dept head
          else 'closed'
        end,
        reopen_count = case when p_rating <= 2 then v_issue.reopen_count + 1 else v_issue.reopen_count end,
        closed_at = case when p_rating > 2 then now() else null end
    where id = v_issue.id;

  insert into issue_status_history (issue_id, status, note, actor)
  values (
    v_issue.id,
    case when p_rating <= 2 then 'reopened' else 'closed' end,
    case
      when p_rating <= 2 and v_issue.reopen_count + 1 >= v_max_reopens
        then format('Resident rated %s/5 - reopen limit reached, escalated to department head', p_rating)
      when p_rating <= 2 then format('Resident rated %s/5 - reopened', p_rating)
      else format('Resident rated %s/5 - closed', p_rating)
    end,
    'resident'
  );
end;
$$;
