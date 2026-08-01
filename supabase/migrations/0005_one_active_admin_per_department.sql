-- A deactivated staff admin was still occupying their department's single admin
-- slot, so the department could never be given a replacement. Deactivation is
-- how staff leave — the slot has to free up when they do.
--
-- The constraint now counts only *active* staff admins. A department may hold any
-- number of deactivated ones (their audit history stays intact) but only one
-- active at a time.

drop index if exists profiles_one_admin_per_department;

create unique index profiles_one_active_admin_per_department
  on profiles (department_id)
  where role = 'dept_admin' and is_active;
