-- Down for 004_tighten_id_constraints.
--
-- Deliberately does NOT restore the loose `[A-Za-z0-9_-]` alphabets from 001-003: those
-- were the defect, and a down migration that reinstates a defect is a trap. It drops
-- the tightened CHECKs and leaves the columns unconstrained.
--
-- Guarded on table existence. Down migrations run newest-first, so this one executes
-- before 001-003 drop the tables — but it also has to be a no-op against an already
-- empty database, which is how the test suite proves "clean from empty".

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('users',         'users_user_id_prefix'),
      ('devices',       'devices_device_id_prefix'),
      ('relationships', 'relationships_contact_id_prefix'),
      ('voice_packs',   'voice_packs_version_prefix'),
      ('messages_out',  'messages_out_id_prefix'),
      ('digests',       'digests_digest_id_prefix'),
      ('briefs',        'briefs_brief_id_prefix')
    ) as t(tbl, cons)
  loop
    if to_regclass('public.' || r.tbl) is not null then
      execute format('alter table %I drop constraint if exists %I', r.tbl, r.cons);
    end if;
  end loop;
end $$;
