-- Telegram replaces Phone as a way to be reached.
--
-- Phone was never delivered: a resident who left a number was recorded and
-- could still track the ticket, but no SMS provider was ever connected and none
-- realistically can be. Commercial SMS to Indian numbers requires TRAI DLT
-- registration -- a registered entity, an approved sender header, and every
-- message template pre-approved -- which is out of reach here. Offering a field
-- that produces nothing is worse than not offering it.
--
-- 'phone' stays permitted so the three tickets already carrying a number remain
-- valid rows; it is simply no longer offered on the form.
--
-- A telegram reporter has no reporter_contact. A bot cannot message anyone by
-- number or username, only by a chat_id it learns when they message it first,
-- so the subscription is created later by the webhook rather than at insert
-- time. That is also why issues_enrol_reporter is untouched by this migration:
-- it enrols email reporters, and there is nothing to enrol here yet.

alter table issues drop constraint if exists issues_reporter_channel_check;

alter table issues add constraint issues_reporter_channel_check
  check (reporter_channel in ('phone', 'email', 'anonymous', 'telegram'));
