-- Deactivating an engineer left their open tickets assigned to them. New work
-- already skipped inactive engineers (pick_engineer_for filters on is_active),
-- but tickets they were already holding stayed on a person who can no longer
-- sign in — and the sweep never reclaimed them, because the sweep only looks at
-- tickets where assigned_to is null.
--
-- Releasing them back to the queue is done in a trigger rather than in the
-- manage-users function so it holds for every path that deactivates someone,
-- including a direct SQL update.

create or replace function profiles_release_tickets_on_deactivate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_released int;
begin
  if old.is_active and not new.is_active then
    with released as (
      update issues
        set assigned_to = null
      where assigned_to = new.id
        and status in ('created', 'assigned', 'in_progress', 'reopened')
      returning id, status
    )
    insert into issue_status_history (issue_id, status, note, actor)
    select
      released.id,
      released.status,
      format('Unassigned - %s was deactivated. Returned to the queue.', new.full_name),
      'system'
    from released;

    get diagnostics v_released = row_count;
    raise notice 'Released % ticket(s) from deactivated user %', v_released, new.full_name;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_release_tickets_trigger on profiles;
create trigger profiles_release_tickets_trigger
  after update of is_active on profiles
  for each row execute function profiles_release_tickets_on_deactivate();

-- Safety net: a ticket already sitting with an inactive or deleted engineer is
-- picked up by the sweep too, not just an unassigned one.
create or replace function sweep_unassigned_issues() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_issue record;
  v_engineer uuid;
  v_name text;
  v_count int := 0;
begin
  for v_issue in
    select i.id, i.department_id, i.status
    from issues i
    left join profiles p on p.id = i.assigned_to
    where i.status in ('created', 'assigned', 'reopened')
      and (i.assigned_to is null or p.id is null or not p.is_active)
    order by
      case i.priority when 'high' then 0 when 'medium' then 1 else 2 end,
      i.created_at
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
