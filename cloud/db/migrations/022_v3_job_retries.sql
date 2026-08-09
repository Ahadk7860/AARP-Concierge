-- 022_v3_job_retries — add retry counter to jobs.
--
-- Reversible: yes — 022_v3_job_retries.down.sql
--
-- Workers can now retry transient failures. After maxAttempts the job is marked
-- 'failed' and the worker emits a loud log. Prior to this migration, every
-- transient failure (Postgres blip, network hiccup) permanently lost the job.

alter table jobs add column if not exists attempts int not null default 0;