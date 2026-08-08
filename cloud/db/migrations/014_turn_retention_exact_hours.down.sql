alter table turns drop constraint if exists turns_90_day_retention;
alter table turns add constraint turns_90_day_retention
  check (expires_at = occurred_at + interval '90 days');
