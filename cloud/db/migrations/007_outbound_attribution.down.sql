-- Down for 007_outbound_attribution. No-op against an empty database.
do $$
begin
  if to_regclass('public.messages_out') is not null then
    drop index if exists messages_out_provider_id_idx;
    alter table messages_out drop constraint if exists messages_out_item_index_range;
    alter table messages_out drop column if exists item_index;
  end if;
end $$;
