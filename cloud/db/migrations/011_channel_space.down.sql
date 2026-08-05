-- Down for 011_channel_space. No-op against an empty database.
do $$
begin
  if to_regclass('public.users') is not null then
    alter table users drop column if exists channel_space_id;
  end if;
end $$;
