-- CivicPulse: three-tier staff roles, weekly roster, and load-based auto-assignment.
--
--   super_admin     -- manages every department and every user; sees everything
--   dept_admin      -- manages one department: its engineers, its roster, its tickets
--   field_engineer  -- works the tickets assigned to them
--
-- Auto-assignment picks the on-shift engineer in the ticket's department holding
-- the fewest open tickets. Reports filed outside roster hours are left unassigned
-- and swept up when the next shift opens.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;

-- Map the Phase 1 roles onto the new hierarchy before re-adding the constraint.
update profiles set role = 'super_admin' where role = 'admin';
update profiles set role = 'dept_admin' where role = 'department_user';

alter table profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'dept_admin', 'field_engineer'));

alter table profiles add column if not exists is_active boolean not null default true;
alter table profiles add column if not exists phone text;
alter table profiles add column if not exists created_by uuid references profiles (id);

-- A dept_admin and a field_engineer must belong to a department; a super_admin must not.
alter table profiles drop constraint if exists profiles_department_required;
alter table profiles
  add constraint profiles_department_required
  check (
    (role = 'super_admin' and department_id is null)
    or (role in ('dept_admin', 'field_engineer') and department_id is not null)
  );

-- Only one staff admin per department, as specified.
create unique index if not exists profiles_one_admin_per_department
  on profiles (department_id)
  where role = 'dept_admin';

create index if not exists profiles_department_role_idx on profiles (department_id, role);

-- ---------------------------------------------------------------------------
-- Caller helpers
--
-- SECURITY DEFINER so a policy on `profiles` can ask "what role is the caller?"
-- without re-entering `profiles` RLS and recursing forever.
-- ---------------------------------------------------------------------------
create or replace function auth_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function auth_department() returns uuid
language sql stable security definer set search_path = public as $$
  select department_id from profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Weekly roster
--
-- weekday: 0 = Monday .. 6 = Sunday. Times are wall-clock IST; the shift lookup
-- converts now() into Asia/Kolkata before comparing.
-- ---------------------------------------------------------------------------
create table if not exists roster_shifts (
  id uuid primary key default gen_random_uuid(),
  engineer_id uuid not null references profiles (id) on delete cascade,
  weekday int not null check (weekday between 0 and 6),
  start_time time not null default '08:00',
  end_time time not null default '18:00',
  created_at timestamptz not null default now(),
  constraint roster_shift_window check (start_time < end_time),
  constraint roster_one_shift_per_day unique (engineer_id, weekday)
);

create index if not exists roster_shifts_engineer_idx on roster_shifts (engineer_id);
create index if not exists roster_shifts_weekday_idx on roster_shifts (weekday);

-- ---------------------------------------------------------------------------
-- Assignment
-- ---------------------------------------------------------------------------

-- Open ticket count per engineer -- this is the "bandwidth" figure.
create or replace function engineer_open_load(p_engineer_id uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from issues
  where assigned_to = p_engineer_id
    and status in ('created', 'assigned', 'in_progress')
$$;

-- The on-shift engineer in this department with the lightest load, or NULL if
-- nobody is rostered right now.
create or replace function pick_engineer_for(p_department_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  with ist as (select (now() at time zone 'Asia/Kolkata') as ts)
  select p.id
  from profiles p
  join roster_shifts rs on rs.engineer_id = p.id
  cross join ist
  where p.role = 'field_engineer'
    and p.is_active
    and p.department_id = p_department_id
    and rs.weekday = extract(isodow from ist.ts)::int - 1
    and ist.ts::time >= rs.start_time
    and ist.ts::time < rs.end_time
  order by engineer_open_load(p.id) asc, p.id asc
  limit 1
$$;

-- Assignment is set BEFORE INSERT so it lands in the same row write rather than
-- triggering a second UPDATE.
create or replace function issues_auto_assign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is null and new.department_id is not null then
    new.assigned_to := pick_engineer_for(new.department_id);
  end if;
  return new;
end;
$$;

drop trigger if exists issues_auto_assign_trigger on issues;
create trigger issues_auto_assign_trigger
  before insert on issues
  for each row execute function issues_auto_assign();

-- Every status-affecting path writes an audit row; auto-assignment is no exception.
create or replace function issues_log_assignment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  if new.assigned_to is not null then
    select full_name into v_name from profiles where id = new.assigned_to;
    insert into issue_status_history (issue_id, status, note, actor)
    values (
      new.id,
      new.status,
      format('Auto-assigned to %s (on shift, lowest open load)', coalesce(v_name, 'engineer')),
      'system'
    );
  else
    insert into issue_status_history (issue_id, status, note, actor)
    values (
      new.id,
      new.status,
      'Queued - no engineer on shift. Will be assigned when the next shift opens.',
      'system'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists issues_log_assignment_trigger on issues;
create trigger issues_log_assignment_trigger
  after insert on issues
  for each row execute function issues_log_assignment();

-- Off-hours queue drain: assigns anything still unassigned to whoever is on
-- shift now. Safe to run repeatedly; a no-op when nothing is waiting.
create or replace function sweep_unassigned_issues() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_issue record;
  v_engineer uuid;
  v_name text;
  v_count int := 0;
begin
  for v_issue in
    select id, department_id, status from issues
    where assigned_to is null
      and status in ('created', 'assigned', 'reopened')
    order by
      case priority when 'high' then 0 when 'medium' then 1 else 2 end,
      created_at
  loop
    v_engineer := pick_engineer_for(v_issue.department_id);
    continue when v_engineer is null;

    update issues set assigned_to = v_engineer where id = v_issue.id;
    select full_name into v_name from profiles where id = v_engineer;

    insert into issue_status_history (issue_id, status, note, actor)
    values (
      v_issue.id,
      v_issue.status,
      format('Assigned to %s by the shift sweep', coalesce(v_name, 'engineer')),
      'system'
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table roster_shifts enable row level security;

-- Staff need to read each other's profiles to show assignee names on tickets.
drop policy if exists profiles_select_all on profiles;
create policy profiles_select_staff on profiles for select
  using (auth.role() = 'authenticated');

-- Direct profile writes are for deactivation and edits; user *creation* goes
-- through the manage-users edge function, which needs the service-role key.
drop policy if exists profiles_insert_admin on profiles;
create policy profiles_insert_admin on profiles for insert
  with check (
    auth_role() = 'super_admin'
    or (auth_role() = 'dept_admin' and role = 'field_engineer' and department_id = auth_department())
  );

drop policy if exists profiles_update_admin on profiles;
create policy profiles_update_admin on profiles for update
  using (
    auth_role() = 'super_admin'
    or (auth_role() = 'dept_admin' and department_id = auth_department())
    or id = auth.uid()
  )
  with check (
    auth_role() = 'super_admin'
    or (auth_role() = 'dept_admin' and department_id = auth_department())
    or id = auth.uid()
  );

-- Roster: readable by staff in the department, writable by that department's
-- admin (or a super_admin).
create policy roster_select_staff on roster_shifts for select
  using (
    auth_role() = 'super_admin'
    or exists (
      select 1 from profiles p
      where p.id = roster_shifts.engineer_id
        and p.department_id = auth_department()
    )
  );

create policy roster_write_admin on roster_shifts for all
  using (
    auth_role() = 'super_admin'
    or (
      auth_role() = 'dept_admin'
      and exists (
        select 1 from profiles p
        where p.id = roster_shifts.engineer_id
          and p.department_id = auth_department()
      )
    )
  )
  with check (
    auth_role() = 'super_admin'
    or (
      auth_role() = 'dept_admin'
      and exists (
        select 1 from profiles p
        where p.id = roster_shifts.engineer_id
          and p.department_id = auth_department()
      )
    )
  );

-- Ticket updates: super_admin anywhere, dept_admin within their department,
-- field_engineer only on tickets assigned to them.
drop policy if exists issues_update_staff on issues;
create policy issues_update_staff on issues for update
  using (
    auth_role() = 'super_admin'
    or (auth_role() = 'dept_admin' and department_id = auth_department())
    or (auth_role() = 'field_engineer' and assigned_to = auth.uid())
  )
  with check (
    auth_role() = 'super_admin'
    or (auth_role() = 'dept_admin' and department_id = auth_department())
    or (auth_role() = 'field_engineer' and assigned_to = auth.uid())
  );

-- Notifications stay staff-only.
drop policy if exists notifications_select_staff on notifications;
create policy notifications_select_staff on notifications for select
  using (auth_role() is not null);

-- ---------------------------------------------------------------------------
-- Scheduled sweep
--
-- pg_cron isn't guaranteed to be installable on every plan, and a failure here
-- would roll back everything above -- so it's attempted, not required. If it
-- doesn't take, call sweep_unassigned_issues() from an external scheduler.
-- ---------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;

  if exists (select 1 from cron.job where jobname = 'civicpulse-assign-sweep') then
    perform cron.unschedule('civicpulse-assign-sweep');
  end if;

  perform cron.schedule(
    'civicpulse-assign-sweep',
    '*/15 * * * *',
    'select sweep_unassigned_issues()'
  );
exception when others then
  raise notice 'pg_cron unavailable (%). Schedule sweep_unassigned_issues() externally.', sqlerrm;
end;
$$;
