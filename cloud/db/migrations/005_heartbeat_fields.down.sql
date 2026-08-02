-- Down for 005_heartbeat_fields. Guarded so it is a no-op against an empty database,
-- which is how the suite proves "clean from empty".
do $$
begin
  if to_regclass('public.devices') is not null then
    alter table devices drop column if exists app_version;
    alter table devices drop column if exists digest_as_of;
    alter table devices drop column if exists macos_version;
    alter table devices drop column if exists fda_granted;
  end if;
end $$;
