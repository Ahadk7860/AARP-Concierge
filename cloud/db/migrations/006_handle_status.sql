-- 006_handle_status — did the first message actually land as iMessage?
--
-- Reversible: yes — 006_handle_status.down.sql
--
-- The number someone types at signup is not necessarily the handle their iMessage is
-- registered to; plenty of people are reachable primarily by an Apple ID email. If the
-- first send comes back as `sms` rather than `imessage`, the whole product premise is
-- already broken for that account — and it is broken BEFORE they have downloaded
-- anything, which is the only moment it is cheap to tell them.
--
-- Recorded per user rather than inferred from `messages_out.protocol` at read time,
-- because it is a property of the ACCOUNT ("we cannot reach you on iMessage") and not
-- of any one message. Prompt 03 sets it; the brief in 05 will need to read it.
alter table users add column if not exists handle_status text not null default 'unknown';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_handle_status_known'
  ) then
    alter table users add constraint users_handle_status_known
      check (handle_status in ('unknown', 'imessage', 'mismatch', 'unreachable'));
  end if;
end $$;
