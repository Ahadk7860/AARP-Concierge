-- 001_identity — the account root and the two properties that cannot be retrofitted.
--
-- Reversible: yes — 001_identity.down.sql
--
-- `users` is the only table here that is NOT hash-partitioned. That is deliberate and
-- it is verbatim CONTRACTS.md section 3: a partitioned table cannot carry a UNIQUE
-- constraint that omits the partition key, and `phone_e164 not null unique` is the
-- constraint signup depends on. `users` is the partition ROOT of identity, not derived
-- data; every table that holds derived user data below is partitioned by hash(user_id)
-- and cascades from it, so delete remains ONE operation.

create table if not exists schema_migrations (
  version     text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);

create table if not exists users (
  user_id      text primary key,
  phone_e164   text not null unique,
  email        text,
  user_salt    bytea not null,     -- issued once at pairing, never rotated
  timezone     text not null default 'America/Los_Angeles',
  created_at   timestamptz not null default now(),

  -- CONTRACTS.md section 6: `usr_` prefix on every user id.
  constraint users_user_id_prefix check (user_id ~ '^usr_[A-Za-z0-9_-]{4,}$'),
  constraint users_phone_e164_shape check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),

  -- The salt is the whole basis of the per-user contact_id namespace. A short salt
  -- or a reused salt would let two users' contact_ids collide, which is exactly the
  -- cross-user join this schema exists to make arithmetically unavailable.
  constraint users_salt_min_32_bytes check (octet_length(user_salt) >= 32),
  constraint users_salt_unique unique (user_salt)
);

-- devices — one row per paired Mac.
--
-- The device token is never stored in the clear, and its cleartext form is
-- `<user_id>.<secret>` (see cloud/db/src/ids.ts). Carrying the user id in the token
-- means authentication resolves the user BEFORE it touches this table, so even the
-- credential lookup is a user-scoped, single-partition query. No global secondary
-- index over a partitioned table, and no unscoped read path.
create table if not exists devices (
  user_id            text not null references users(user_id) on delete cascade,
  device_id          text not null,
  device_token_hash  bytea not null,
  platform           text not null default 'macos',
  last_heartbeat_at  timestamptz,
  created_at         timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint devices_device_id_prefix check (device_id ~ '^dev_[A-Za-z0-9_-]{4,}$'),
  constraint devices_token_hash_len check (octet_length(device_token_hash) = 32),
  constraint devices_platform_known check (platform in ('macos', 'test')),
  unique (user_id, device_token_hash)
) partition by hash (user_id);

-- relationships — CONTRACTS.md section 3, verbatim, plus the partitions.
--
-- contact_id = HMAC(user_salt, normalized_handle), computed ON THE MAC. The same
-- phone number produces a DIFFERENT id for every user, so cross-user joins are
-- arithmetically unavailable -- not "forbidden by policy" but unavailable to a rogue
-- query or a subpoena. The server NEVER sees a raw handle for anyone but the account
-- holder.
create table if not exists relationships (
  user_id      text not null references users(user_id) on delete cascade,
  contact_id   text not null,
  display      text not null,
  payload      jsonb not null,     -- conforms to digest.v1 $defs/relationship
  as_of        timestamptz not null,
  primary key (user_id, contact_id),
  constraint relationships_contact_id_prefix check (contact_id ~ '^h_[0-9a-f]{8,}$')
) partition by hash (user_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['devices', 'relationships'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
