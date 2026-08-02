-- 007_outbound_attribution — the omsg_ -> provider-id mapping a reply is resolved by.
--
-- Reversible: yes — 007_outbound_attribution.down.sql
--
-- `inbound.v1.reply_to_message_id` carries the PROVIDER's id for the message being
-- replied to — `lmsg_...` from Linq, `omsg_stub_N` from the foundation stub. Track D
-- owns the mapping back to its own `omsg_`, and the only place that link ever exists is
-- `SendResult.message_id`, returned once at send time. If it is not written down there
-- it cannot be reconstructed afterwards, and a user's reply of "2" attributes to
-- nothing.
--
-- `provider_message_id` already existed on this table; what was missing is which BRIEF
-- ITEM the message rendered. Without it a threaded reply resolves to a brief but not to
-- a person, and picking the first item would be a guess.
--
-- Deliberately no CHECK on the id's prefix. The value comes from whichever transport
-- sent it, and hard-coding `lmsg_` would break the stub while hard-coding `omsg_` would
-- break Linq. Track D never parses it; it only matches it.
alter table messages_out add column if not exists item_index integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_out_item_index_range') then
    alter table messages_out add constraint messages_out_item_index_range
      check (item_index is null or item_index between 0 and 2);
  end if;
end $$;

-- The reply-attribution lookup. Scoped by user_id because the resolver knows the user
-- before it knows the message: inbound.v1 carries user_id, and when it does not, the
-- account holder's own handle resolves it. No global secondary index, no unscoped read.
create index if not exists messages_out_provider_id_idx
  on messages_out (user_id, provider_message_id);
