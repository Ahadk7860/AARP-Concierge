-- 023_v3_job_lease_index — index to support reclaiming stuck 'running' jobs.
--
-- Reversible: yes — 023_v3_job_lease_index.down.sql
--
-- Incident: a worker died holding a job mid-ingest. dequeue() only ever selected
-- status = 'pending', so the row stayed 'running' forever — no retry, no alert,
-- no way back. The user's data survived only because a later sync produced a new
-- job; that was luck, not design.
--
-- The fix (queue.ts: reclaimStuckJobs, called from dequeue) needs no new column —
-- started_at, set when a job is claimed, is already the lease clock. This migration
-- only adds the index that makes "find running jobs whose lease expired" cheap,
-- since that scan is now on the hot path of every dequeue() call.

create index if not exists jobs_running_started_at_idx
  on jobs (status, started_at)
  where status = 'running';
