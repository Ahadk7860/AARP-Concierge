-- 005_heartbeat_fields — what POST /v1/heartbeat records.
--
-- Reversible: yes — 005_heartbeat_fields.down.sql
--
-- `contracts/openapi/boi-api.v1.yaml` gives the heartbeat body four fields beyond
-- `device_id`, and prompt 02 requires `digest_as_of` to be recorded "so staleness is
-- computable". 001 gave `devices` only `last_heartbeat_at`, which answers "is the Mac
-- awake" but not "how old is the newest fact we hold" — and those are different
-- questions. CONTRACTS.md's second load-bearing property is that the Mac is allowed to
-- be asleep and staleness is a VISIBLE STATE, never a silent wrong answer, so the
-- brief in prompt 05 needs the second answer, not the first.
--
-- `digest_as_of` is what the DEVICE claims it last computed. It is deliberately not the
-- same as `digests.as_of`, which is what the server actually holds: a Mac that has
-- computed a digest it has not uploaded yet is a real state, and collapsing the two
-- would hide it.

alter table devices add column if not exists app_version    text;
alter table devices add column if not exists digest_as_of   timestamptz;
alter table devices add column if not exists macos_version  text;
alter table devices add column if not exists fda_granted    boolean;
