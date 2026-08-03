-- 004_tighten_id_constraints — make the SQL CHECKs match the frozen JSON Schemas.
--
-- Reversible: yes — 004_tighten_id_constraints.down.sql
--
-- Migrations 001-003 spelled every id constraint `[A-Za-z0-9_-]`, which is LOOSER than
-- the wire contract in `contracts/schema/*.json`:
--
--   usr_  ^usr_[0-9a-zA-Z]{8,32}$     digest.v1.json
--   dev_  ^dev_[0-9a-zA-Z]{8,32}$     digest.v1.json
--   h_    ^h_[0-9a-f]{8,32}$          digest.v1.json, brief.v1.json, gist.v1.json
--   vp_   ^vp_[0-9a-f]{8,16}$         voice_pack.v1.json
--
-- Neither contract alphabet contains `-` or `_`, and neither is unbounded above. The
-- looser CHECKs are why a generator emitting base64url ids passed every local test
-- while producing documents Track A's validator would have rejected about a third of
-- the time. The database is the last place that can catch this before it becomes an
-- intermittent integration failure, so it now enforces the contract exactly.
--
-- Written as a new migration rather than an edit to 001-003: those have been applied,
-- and the runner rejects a changed checksum on purpose.

alter table users drop constraint if exists users_user_id_prefix;
alter table users add constraint users_user_id_prefix
  check (user_id ~ '^usr_[0-9a-zA-Z]{8,32}$');

alter table devices drop constraint if exists devices_device_id_prefix;
alter table devices add constraint devices_device_id_prefix
  check (device_id ~ '^dev_[0-9a-zA-Z]{8,32}$');

alter table relationships drop constraint if exists relationships_contact_id_prefix;
alter table relationships add constraint relationships_contact_id_prefix
  check (contact_id ~ '^h_[0-9a-f]{8,32}$');

alter table voice_packs drop constraint if exists voice_packs_version_prefix;
alter table voice_packs add constraint voice_packs_version_prefix
  check (voice_pack_version ~ '^vp_[0-9a-f]{8,16}$');

alter table voice_packs drop constraint if exists voice_packs_scope_matches_contact;
alter table voice_packs add constraint voice_packs_scope_matches_contact
  check (
    (scope = 'global' and contact_id is null)
    or (scope = 'contact' and contact_id ~ '^h_[0-9a-f]{8,32}$')
  );

-- `omsg_` is in CONTRACTS.md section 6's prefix list but has no JSON Schema pattern,
-- so it follows the `usr_`/`dev_` alphabet rather than inventing a third one.
alter table messages_out drop constraint if exists messages_out_id_prefix;
alter table messages_out add constraint messages_out_id_prefix
  check (message_id ~ '^omsg_[0-9a-zA-Z]{8,32}$');

-- `dig_` and `brf_` are PROVISIONAL: neither prefix appears in CONTRACTS.md section 6.
-- Section 4 names `digest_id` in the `digest.ingested` payload, so an id must exist.
-- Recorded as a contract gap in NOTES.md; constrained here so that whatever the user
-- rules, the shape in the database is at least consistent and checkable.
alter table digests drop constraint if exists digests_digest_id_prefix;
alter table digests add constraint digests_digest_id_prefix
  check (digest_id ~ '^dig_[0-9a-f]{8,32}$');

alter table briefs drop constraint if exists briefs_brief_id_prefix;
alter table briefs add constraint briefs_brief_id_prefix
  check (brief_id ~ '^brf_[0-9a-f]{8,32}$');
