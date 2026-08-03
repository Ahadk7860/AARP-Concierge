-- Down for 006_handle_status. Guarded so it is a no-op against an empty database.
do $$
begin
  if to_regclass('public.users') is not null then
    alter table users drop constraint if exists users_handle_status_known;
    alter table users drop column if exists handle_status;
  end if;
end $$;
