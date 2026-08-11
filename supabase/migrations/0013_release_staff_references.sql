-- Lets a staff account be deleted outright, not just deactivated.
--
-- Two foreign keys block a delete today, both NO ACTION:
--   issues.assigned_to    -> profiles
--   profiles.created_by   -> profiles
-- Everything else already cascades (roster_shifts, and the auth tables behind
-- profiles.id).
--
-- The point of this function is what it refuses to remove. "Remove all
-- references" cannot mean the tickets: an engineer leaving is not a reason for
-- a pothole report to disappear. So their work is released, not deleted --
-- issues go back to the queue exactly as they do when someone is deactivated
-- (0004), and sweep_unassigned_issues picks them up on its next run.
--
-- issue_status_history is deliberately untouched. `actor` is text, not a
-- foreign key, so "Marked resolved by Ravi Kumar" survives on its own. That is
-- the intent, not an oversight: the audit trail records what happened, and
-- rewriting it because someone later left would make it a record of who still
-- works here instead.

create or replace function release_staff_references(p_user_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_issue record;
  v_released int := 0;
begin
  select full_name into v_name from profiles where id = p_user_id;
  if v_name is null then
    return 0;                       -- no such staff member; nothing to release
  end if;

  -- Unassigned one at a time so each ticket gets its own audit row saying why
  -- it moved. Status is untouched, so this does not fire the notification
  -- trigger -- residents are not told their ticket "changed" because an
  -- engineer left.
  for v_issue in select id, status from issues where assigned_to = p_user_id loop
    update issues set assigned_to = null where id = v_issue.id;

    insert into issue_status_history (issue_id, status, note, actor)
    values (
      v_issue.id,
      v_issue.status,
      format('Returned to the queue: %s was removed from CivicPulse', v_name),
      'system'
    );

    v_released := v_released + 1;
  end loop;

  -- Who created an account matters less than the account existing. Nulled
  -- rather than cascaded, or deleting an admin would delete everyone they ever
  -- provisioned.
  update profiles set created_by = null where created_by = p_user_id;

  return v_released;
end;
$$;

-- Service role only: the edge function calls this after deciding the caller is
-- allowed to delete the target. Nothing resident- or staff-facing may reach it.
revoke execute on function release_staff_references(uuid) from public, anon, authenticated;
