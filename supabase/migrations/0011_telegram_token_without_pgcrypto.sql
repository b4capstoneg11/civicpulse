-- Fix: create_telegram_link_token() raised
--   42883: function gen_random_bytes(integer) does not exist
-- on every call, so no Telegram link could be issued.
--
-- gen_random_bytes belongs to pgcrypto, which Supabase installs into the
-- `extensions` schema. The function pins `search_path = public` -- as every
-- SECURITY DEFINER function here does, deliberately, so a caller cannot shadow
-- the objects it resolves -- and that puts pgcrypto out of reach. gen_random_uuid()
-- misleads by comparison: it looks like pgcrypto but has been core since
-- Postgres 13, which is why the table defaults in 0007 work.
--
-- Rather than qualify the call as extensions.gen_random_bytes and depend on
-- where an extension happens to be installed, the token now comes from
-- pg_catalog alone: a random uuid's 16 bytes, base64url-encoded to 22
-- characters. Same 128 bits of entropy, comfortably inside Telegram's 64-char
-- deep-link payload limit, and no extension dependency at all.

create or replace function create_telegram_link_token(p_ticket_number text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_issue_id uuid;
  v_token text;
  v_outstanding int;
  v_max_outstanding constant int := 20;
begin
  select id into v_issue_id
    from issues where ticket_number = upper(trim(p_ticket_number));

  if v_issue_id is null then
    raise exception 'Ticket % not found', p_ticket_number;
  end if;

  -- Opportunistic cleanup, so expired rows do not need their own cron job.
  delete from telegram_link_tokens
   where created_at < now() - interval '24 hours';

  select count(*) into v_outstanding
    from telegram_link_tokens
   where issue_id = v_issue_id and used_at is null;

  if v_outstanding >= v_max_outstanding then
    raise exception 'Too many outstanding Telegram links for this ticket';
  end if;

  v_token := replace(replace(replace(
    encode(uuid_send(gen_random_uuid()), 'base64'), '+', '-'), '/', '_'), '=', '');

  insert into telegram_link_tokens (token, issue_id) values (v_token, v_issue_id);
  return v_token;
end;
$$;

revoke execute on function create_telegram_link_token(text) from public, anon, authenticated;
grant execute on function create_telegram_link_token(text) to anon, authenticated;
