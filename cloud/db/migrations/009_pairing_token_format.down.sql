-- Down for 009_pairing_token_format. No-op against an empty database.
--
-- Restoring the six-digit constraint FAILS if any `boi-…` token is still stored, and
-- that is correct: rolling back a widening while the wider values exist is a data
-- question, not a schema one. Delete or expire the tokens first.
do $$
begin
  if to_regclass('public.pairing_codes') is not null then
    alter table pairing_codes drop constraint if exists pairing_codes_shape;
    if not exists (select 1 from pg_constraint where conname = 'pairing_codes_six_digits') then
      alter table pairing_codes add constraint pairing_codes_six_digits
        check (code ~ '^[0-9]{6}$');
    end if;
  end if;
end $$;
