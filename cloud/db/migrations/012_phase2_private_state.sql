-- 012_phase2_private_state — reserved storage seams for Phase 2.
--
-- Reversible: yes — 012_phase2_private_state.down.sql
--
-- These tables intentionally contain ciphertext only. Encryption/decryption and the
-- platform master secret are Track H's wiring; stream ingestion and scheduled purging
-- are Track I's behavior. This migration creates no plaintext path.

create table if not exists contact_handles (
  user_id text not null references users(user_id) on delete cascade,
  contact_id text not null,
  ciphertext bytea not null,
  key_envelope bytea not null,
  algorithm text not null default 'aes-256-gcm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, contact_id),
  constraint contact_handles_contact_id_format check (contact_id ~ '^h_[0-9a-f]{8,32}$'),
  constraint contact_handles_ciphertext_nonempty check (octet_length(ciphertext) > 0),
  constraint contact_handles_envelope_nonempty check (octet_length(key_envelope) > 0)
) partition by hash (user_id);

create table if not exists turns (
  user_id text not null references users(user_id) on delete cascade,
  turn_id text not null,
  direction text not null,
  ciphertext bytea not null,
  key_envelope bytea not null,
  occurred_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, turn_id),
  constraint turns_direction_known check (direction in ('inbound', 'outbound')),
  constraint turns_ciphertext_nonempty check (octet_length(ciphertext) > 0),
  constraint turns_envelope_nonempty check (octet_length(key_envelope) > 0),
  constraint turns_90_day_retention check (expires_at = occurred_at + interval '90 days')
) partition by hash (user_id);

create index if not exists turns_expiry_idx on turns (expires_at);

do $$ declare t text; i int; begin
  foreach t in array array['contact_handles', 'turns'] loop
    for i in 0..7 loop
      execute format('create table if not exists %I partition of %I for values with (modulus 8, remainder %s)', t || '_p' || i, t, i);
    end loop;
  end loop;
end $$;

-- TODO(track-i): call DELETE FROM turns WHERE expires_at <= now() from the inbound
-- worker's retention job, and prove it with a controlled clock. Do not expose a
-- plaintext repository method; the cloud only receives encrypted turn envelopes.
