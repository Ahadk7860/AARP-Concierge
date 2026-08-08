-- `interval '90 days'` follows the database session timezone across DST and can become
-- 2159/2161 elapsed hours. Phase 2 retention is an exact boundary, so pin 2160 hours.
alter table turns drop constraint if exists turns_90_day_retention;
alter table turns add constraint turns_90_day_retention
  check (expires_at = occurred_at + interval '2160 hours');
