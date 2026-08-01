-- Fix: `notifications` had RLS enabled but only a SELECT policy, so every insert
-- was denied — 401 for the anonymous resident submitting a report, 403 for staff
-- resolving a ticket. The frontend never checked the error, so the whole
-- notification log silently recorded nothing.
--
-- Insert is public for the same reason `issues` and `issue_status_history` are:
-- residents report and track without an account, and a notification row is
-- written alongside those actions. Reads stay staff-only, so a resident can
-- write a log line but cannot read anyone else's contact details back out.

create policy notifications_insert_public on notifications for insert
  with check (true);
