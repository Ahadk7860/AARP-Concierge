-- 009_pairing_token_format — the pairing secret is no longer six digits the user types.
--
-- Reversible: yes — 009_pairing_token_format.down.sql
--
-- AMENDMENT-002 inverts onboarding: the user opens the thread from an `sms:` deep link
-- whose body is PREFILLED with the pairing secret, so nobody types it and the six-digit
-- shape has no reason to be six digits any more.
--
-- WHY THE CONSTRAINT MOVED RATHER THAN THE TABLE.
--
-- `check (code ~ '^[0-9]{6}$')` is documentation. Stuffing an opaque token into a column
-- whose constraint says "six digits" makes the schema describe the old design while
-- holding the new one — the same defect as a test that still asserts a flow we replaced,
-- and harder to notice because a constraint reads as authority.
--
-- A second `pairing_tokens` table was rejected for the opposite reason: the lifecycle is
-- identical. Same single-use consumption, same expiry, same binding to exactly one
-- user_id, same "live code" partial index. A second table duplicates all of it and then
-- has to be kept in step forever.
--
-- THE FORMAT, and it is a product constraint rather than a security one. The token sits
-- in the thread permanently and the user rereads it every time they scroll up, so it has
-- to look like plumbing rather than like a secret they are supposed to guard:
--
--     boi-4f2a91
--
-- Entropy is not what protects this. The inbound path requires the message to arrive
-- from a handle registered to that user, and an attacker who controls that handle has
-- already won by other means. EXPIRY is the protection, and it is unchanged: ten minutes,
-- single use, one user.
--
-- The six-digit form stays valid, deliberately. `POST /v1/pair` still accepts a code, the
-- Mac's own pairing surface is Track F's and is mid-flight, and a migration that
-- invalidated every live code would break the accounts created in the minute before
-- deploy for no benefit.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'pairing_codes_six_digits') then
    alter table pairing_codes drop constraint pairing_codes_six_digits;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pairing_codes_shape') then
    -- Six digits, OR `boi-` and six lowercase hex. Deliberately NOT "any string": a
    -- constraint that permits everything is a column comment, and the point of this
    -- migration is that the constraint should say what is actually in there.
    alter table pairing_codes add constraint pairing_codes_shape
      check (code ~ '^[0-9]{6}$' or code ~ '^boi-[0-9a-f]{6}$');
  end if;
end $$;
