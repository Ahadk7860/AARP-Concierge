-- Down for 008_brief_delivery_state. No-op against an empty database.
do $$
begin
  if to_regclass('public.briefs') is not null then
    drop index if exists briefs_pending_idx;
    alter table briefs drop constraint if exists briefs_sent_has_timestamp;
    alter table briefs drop constraint if exists briefs_delivery_status_known;
    alter table briefs drop column if exists last_error;
    alter table briefs drop column if exists attempts;
    alter table briefs drop column if exists delivery_status;
  end if;
end $$;
