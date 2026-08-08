-- Durable, ciphertext-only state machine for inbound decisions and reply delivery.
-- The canonical reply body remains in `turns`; this table stores only opaque ids/state.

create table if not exists inbound_outbox (
  user_id text not null references users(user_id) on delete cascade,
  event_key text not null,
  inbound_turn_id text not null,
  outbound_turn_id text,
  delivery_key text not null,
  delivery_status text not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, event_key),
  constraint inbound_outbox_event_key check (event_key ~ '^[0-9a-f]{32}$'),
  constraint inbound_outbox_delivery_key check (delivery_key ~ '^[0-9a-f]{32}$'),
  constraint inbound_outbox_state check (delivery_status in ('pending', 'sent', 'no_reply')),
  constraint inbound_outbox_reply_state check (
    (outbound_turn_id is null and delivery_status = 'no_reply' and delivered_at is null)
    or
    (outbound_turn_id is not null and delivery_status in ('pending', 'sent')
      and (delivery_status = 'pending' or delivered_at is not null))
  )
) partition by hash (user_id);

do $$ declare i int; begin
  for i in 0..7 loop
    execute format('create table if not exists %I partition of inbound_outbox for values with (modulus 8, remainder %s)', 'inbound_outbox_p' || i, i);
  end loop;
end $$;
