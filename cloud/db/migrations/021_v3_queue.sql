-- 021_v3_queue — one queue per workload class.
--
-- Reversible: yes — 021_v3_queue.down.sql
--
-- Six workload classes, one table, distinguished by the `queue` column.
-- At <1k users a single-worker-pool implementation is correct; the separation
-- in the data model means splitting into dedicated workers later is a deploy
-- change, not a migration.

create table if not exists jobs (
  job_id     text primary key,
  queue      text not null,       -- 'interactive'|'ingest'|'derive'|'precompute'|'proactive'|'reanalysis'
  user_id    text not null references users(user_id) on delete cascade,
  payload    jsonb not null,
  status     text not null default 'pending',  -- 'pending'|'running'|'done'|'failed'
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error      text,
  priority   int not null default 0
);

create index if not exists jobs_queue_status_idx on jobs (queue, status, priority desc, created_at);
