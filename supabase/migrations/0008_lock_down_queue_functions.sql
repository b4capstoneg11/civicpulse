-- Fix: the queue plumbing in 0007 was still callable by anonymous visitors.
--
-- 0007 ended with `revoke execute ... from public`, which is the usual advice
-- and is not enough on Supabase. Supabase ships
--
--   alter default privileges in schema public
--     grant all on functions to postgres, anon, authenticated, service_role;
--
-- so every new function is granted EXECUTE *directly* to anon and authenticated
-- as well as to PUBLIC. Revoking PUBLIC leaves the direct grants untouched, and
-- the functions stayed open. Verified against the deployed project: an
-- anonymous caller could run claim_notifications() and requeue_stuck_notifications().
--
-- Impact had this shipped: claim_notifications returns whole notification rows,
-- so anon could read every queued recipient address and payload; it also flips
-- rows to 'sending', which would make the real worker skip them, and
-- mark_notification_sent() would let anyone discard a resident's mail silently.
--
-- `subscribe_to_ticket` is deliberately left callable by anon -- it is the
-- resident-facing one, and 0007 grants it explicitly.

revoke execute on function enqueue_issue_notifications(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke execute on function claim_notifications(int)
  from public, anon, authenticated;
revoke execute on function mark_notification_sent(uuid)
  from public, anon, authenticated;
revoke execute on function mark_notification_failed(uuid, text)
  from public, anon, authenticated;
revoke execute on function requeue_stuck_notifications(interval)
  from public, anon, authenticated;

-- The same default-privilege trap applies to anything added later, so pin the
-- default for future functions in this schema rather than relying on every
-- migration remembering to revoke.
alter default privileges in schema public revoke execute on functions from anon;
