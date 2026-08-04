-- Down for 009_pairing_token_format. No-op against an empty database.
--
-- IT DELETES THE TOKENS IT CANNOT REPRESENT, and the first version of this did not —
-- it re-added the six-digit constraint and let Postgres refuse if a `boi-…` token was
-- still stored, on the theory that rolling back a widening over wider data is a data
-- question rather than a schema one.
--
-- That reasoning is wrong for THIS data and the failure proved it: `rollbackAll` is how
-- `cloud/db/src/schema.test.ts` rebuilds the schema, so one leftover token from a test
-- run made an entire suite unable to start. A down migration that cannot run is not a
-- rollback.
--
-- Deleting is safe here in a way it would not be for a normal table: a pairing secret is
-- single-use, ten minutes old at most, and reissued by signing up again. The worst case
-- for a real user is that they tap the link and re-sign-up; the worst case for the old
-- behaviour was a schema that could not be rolled back at all.
do $$
begin
  if to_regclass('public.pairing_codes') is not null then
    alter table pairing_codes drop constraint if exists pairing_codes_shape;
    delete from pairing_codes where code !~ '^[0-9]{6}$';
    if not exists (select 1 from pg_constraint where conname = 'pairing_codes_six_digits') then
      alter table pairing_codes add constraint pairing_codes_six_digits
        check (code ~ '^[0-9]{6}$');
    end if;
  end if;
end $$;
