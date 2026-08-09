-- 020_v3_relationships_extend_cache — extend relationships, add precomputed_answers.
--
-- Reversible: yes — 020_v3_relationships_extend_cache.down.sql
--
-- Adds v3 trajectory columns to the existing hash-partitioned relationships table.
-- Also creates precomputed_answers for the router's cache-hit path.

alter table relationships
  add column if not exists lifecycle_stage text,
  add column if not exists tie_context text,
  add column if not exists expected_gap_days double precision,
  add column if not exists overdue_by_days double precision,
  add column if not exists response_latency_me_min double precision,
  add column if not exists response_latency_them_min double precision,
  add column if not exists importance text;

create table if not exists precomputed_answers (
  user_id     text not null references users(user_id) on delete cascade,
  intent      text not null,
  answer      jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, intent)
) partition by hash (user_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['precomputed_answers'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
