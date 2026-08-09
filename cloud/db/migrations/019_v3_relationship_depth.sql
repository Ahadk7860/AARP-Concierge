-- 019_v3_relationship_depth — open_loops, relationship_metrics_daily, relationship_edges.
--
-- Reversible: yes — 019_v3_relationship_depth.down.sql
--
-- These three tables deepen the existing relationships table with trajectory data.
-- open_loops captures questions, promises, plans the system detects.
-- relationship_metrics_daily stores per-day snapshots of each relationship.
-- relationship_edges models the social graph between contacts.

create table if not exists open_loops (
  user_id     text not null references users(user_id) on delete cascade,
  loop_id     text primary key,
  person_id   text not null,
  kind        text not null,
  direction   text not null,
  description text not null,
  opened_at   timestamptz not null,
  status      text not null default 'open',
  confidence  text not null,
  as_of       timestamptz not null
) partition by hash (user_id);

create table if not exists relationship_metrics_daily (
  user_id    text not null references users(user_id) on delete cascade,
  person_id  text not null,
  day        date not null,
  message_count int not null,
  momentum   double precision,
  initiation_ratio double precision,
  median_gap_days double precision,
  response_latency_me_min  double precision,
  response_latency_them_min double precision,
  register   text,
  primary key (user_id, person_id, day)
) partition by hash (user_id);

create table if not exists relationship_edges (
  user_id      text not null references users(user_id) on delete cascade,
  person_a     text not null,
  person_b     text not null,
  shared_groups int not null default 0,
  co_mentions   int not null default 0,
  tie_strength  double precision,
  as_of        timestamptz not null,
  primary key (user_id, person_a, person_b)
) partition by hash (user_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['open_loops', 'relationship_metrics_daily', 'relationship_edges'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
