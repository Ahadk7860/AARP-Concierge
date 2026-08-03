-- 003_pairing_and_delivery — pairing codes, composed briefs, outbound messages.
--
-- Reversible: yes — 003_pairing_and_delivery.down.sql

-- pairing_codes — six digits, short-lived, single use.
--
-- A six-digit code cannot carry the user id the way a device token can, so resolving
-- one is the single lookup in the system that legitimately begins without a user_id.
-- It is confined to `bootstrapLookups.resolvePairingCode` in the repository layer,
-- which returns an id and nothing else -- never user content.
--
-- Global uniqueness of a LIVE code cannot be a UNIQUE constraint here, because a
-- unique constraint on a hash-partitioned table must include the partition key and
-- including user_id would defeat the point. It is enforced instead by a transactional
-- advisory lock on the code in `issuePairingCode`, which is a real mutual exclusion,
-- not a check-then-hope.
create table if not exists pairing_codes (
  user_id     text not null references users(user_id) on delete cascade,
  code        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  primary key (user_id, code),
  constraint pairing_codes_six_digits check (code ~ '^[0-9]{6}$'),
  constraint pairing_codes_expiry_after_creation check (expires_at > created_at)
) partition by hash (user_id);

-- Supports the cross-partition scan `resolvePairingCode` performs and the uniqueness
-- probe `issuePairingCode` performs under the advisory lock.
create index if not exists pairing_codes_live_code_idx
  on pairing_codes (code) where consumed_at is null;

-- briefs — the composed brief.v1 document for one scheduled morning.
create table if not exists briefs (
  user_id       text not null references users(user_id) on delete cascade,
  brief_id      text not null,
  scheduled_for timestamptz not null,
  payload       jsonb not null,      -- conforms to brief.v1
  digest_as_of  timestamptz not null,
  hours_stale   numeric(10, 2) not null,
  warn          boolean not null default false,
  item_count    integer not null,
  card_url      text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  primary key (user_id, brief_id),
  -- CONTRACTS.md section 0: at most three people, every morning.
  constraint briefs_at_most_three_items check (item_count between 0 and 3),
  -- Unnamed for the same reason as digests: the error names the partition's index.
  unique (user_id, scheduled_for)
) partition by hash (user_id);

-- messages_out — every outbound.v1 document handed to the Channel.
--
-- `unique (user_id, idempotency_key)` is what makes a retried send safe: the composer
-- emits blocks and never learns the protocol, so replay protection has to live here.
create table if not exists messages_out (
  user_id             text not null references users(user_id) on delete cascade,
  message_id          text not null,
  idempotency_key     text not null,
  brief_id            text,
  blocks              jsonb not null,   -- outbound.v1 `blocks`
  status              text not null default 'pending',
  provider            text,
  provider_message_id text,
  protocol            text,
  line_id             text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  primary key (user_id, message_id),
  constraint messages_out_id_prefix check (message_id ~ '^omsg_[A-Za-z0-9_-]{4,}$'),
  constraint messages_out_status_known check (status in ('pending', 'sent', 'failed')),
  constraint messages_out_protocol_known check (protocol is null or protocol in ('imessage', 'rcs', 'sms')),
  unique (user_id, idempotency_key)
) partition by hash (user_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['pairing_codes', 'briefs', 'messages_out'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
