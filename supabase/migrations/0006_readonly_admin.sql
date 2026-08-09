-- A fourth role: `readonly_admin`. Sees everything a super admin sees, across
-- every department, and can change nothing.
--
-- Access control here is the RLS policies, not the UI. The UI hides the
-- controls so the role is not confusing to use, but what makes it read-only is
-- that the role appears in no write policy.

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'readonly_admin', 'dept_admin', 'field_engineer'));

-- A readonly_admin is global, like a super admin, so it carries no department.
alter table profiles drop constraint if exists profiles_department_required;
alter table profiles
  add constraint profiles_department_required
  check (
    (role in ('super_admin', 'readonly_admin') and department_id is null)
    or (role in ('dept_admin', 'field_engineer') and department_id is not null)
  );

-- ---------------------------------------------------------------------------
-- Reads
--
-- departments, profiles, issues, issue_status_history and notifications are
-- already readable by any authenticated staff member, so they need no change.
-- The roster is the exception: it is scoped by department, and a global role
-- has none, so without this a readonly_admin would see an empty roster.
-- ---------------------------------------------------------------------------
drop policy if exists roster_select_staff on roster_shifts;
create policy roster_select_staff on roster_shifts for select
  using (
    auth_role() in ('super_admin', 'readonly_admin')
    or exists (
      select 1 from profiles p
      where p.id = roster_shifts.engineer_id
        and p.department_id = auth_department()
    )
  );

-- ---------------------------------------------------------------------------
-- Writes
--
-- Nothing to add. `issues_update_staff`, `roster_write_admin` and
-- `profiles_insert_admin` all name the roles they permit, and `readonly_admin`
-- is not among them, so it is denied by default.
--
-- Except for one hole, which a read-only role makes urgent.
--
-- `profiles_update_admin` permits `id = auth.uid()` with no restriction on
-- which columns may change, so any staff member could run
--
--     update profiles set role = 'super_admin', department_id = null
--     where id = auth.uid();
--
-- and promote themselves. Verified against this database by impersonating an
-- active field engineer inside a transaction and rolling it back: the update
-- succeeded. That predates this role and affects every existing one, but it
-- would also make `readonly_admin` decorative, so it is closed here.
--
-- A trigger rather than a policy, because a policy's WITH CHECK sees only the
-- new row and cannot tell which columns changed.
-- ---------------------------------------------------------------------------
create or replace function profiles_guard_privileged_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Ordinary edits — name, phone — are nobody's business but the owner's.
  if new.role is not distinct from old.role
     and new.department_id is not distinct from old.department_id
     and new.is_active is not distinct from old.is_active
  then
    return new;
  end if;

  -- No JWT means the service-role key or the SQL editor. Both bypass RLS
  -- entirely, so refusing them here would block legitimate server-side work
  -- while stopping no attacker: this is the path `manage-users` uses to create
  -- staff and to activate and deactivate them.
  if auth.uid() is null then
    return new;
  end if;

  if auth_role() = 'super_admin' then
    return new;
  end if;

  raise exception 'Changing role, department or active status is not permitted for this account'
    using errcode = '42501';
end;
$$;

drop trigger if exists profiles_guard_privileged_columns_trigger on profiles;
create trigger profiles_guard_privileged_columns_trigger
  before update on profiles
  for each row execute function profiles_guard_privileged_columns();
