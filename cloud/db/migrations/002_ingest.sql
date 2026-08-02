-- 002_ingest — what the Mac uploads: digests and voice packs.
--
-- Reversible: yes — 002_ingest.down.sql

-- digests — one row per T0 upload.
--
-- `unique (user_id, generated_at)` is the constraint behind the documented
-- `409 {"error":"duplicate"}` on POST /v1/digest for a repeated generated_at.
create table if not exists digests (
  user_id       text not null references users(user_id) on delete cascade,
  digest_id     text not null,
  device_id     text not null,
  generated_at  timestamptz not null,
  corpus_health text not null,
  payload       jsonb not null,     -- conforms to digest.v1
  as_of         timestamptz not null,
  received_at   timestamptz not null default now(),
  primary key (user_id, digest_id),
  constraint digests_health_known check (corpus_health in ('healthy', 'fixable', 'thin')),
  -- Left unnamed deliberately. A UNIQUE constraint on a partitioned table is enforced
  -- by a per-partition index, and a violation reports THAT index's name
  -- (`digests_p3_user_id_generated_at_key`), never a name declared here. Code that
  -- has to recognise the violation matches the column-derived suffix; a custom name
  -- would be documentation that never appears in the error it documents.
  unique (user_id, generated_at)
) partition by hash (user_id);

-- voice_packs — the user's OWN sent messages, redacted on the Mac.
--
-- CONTRACTS.md section 7: a pack that fails the is_from_me guard is rejected at the
-- upload boundary with 422 redaction_failed and NOTHING is stored. Nothing in this
-- table is therefore ever partially written; the HTTP layer (prompt 02) validates
-- before it calls the repository.
create table if not exists voice_packs (
  user_id            text not null references users(user_id) on delete cascade,
  voice_pack_version text not null,
  scope              text not null,
  contact_id         text,
  n_exemplars        integer,
  payload            jsonb not null,   -- conforms to voice_pack.v1
  as_of              timestamptz not null,
  received_at        timestamptz not null default now(),
  primary key (user_id, voice_pack_version),
  constraint voice_packs_version_prefix check (voice_pack_version ~ '^vp_[A-Za-z0-9_-]{4,}$'),
  constraint voice_packs_scope_known check (scope in ('contact', 'global')),
  -- scope and contact_id must agree: a global pack has no contact, a contact pack has one.
  constraint voice_packs_scope_matches_contact check (
    (scope = 'global' and contact_id is null)
    or (scope = 'contact' and contact_id ~ '^h_[0-9a-f]{8,}$')
  )
) partition by hash (user_id);

create index if not exists voice_packs_user_scope_idx
  on voice_packs (user_id, scope, contact_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['digests', 'voice_packs'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
