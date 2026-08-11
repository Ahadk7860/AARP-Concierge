// Postgres-backed job queue — one table, six workload classes.
//
// At current scale (<1k users) a single worker loop polling all queues is correct.
// The `queue` column separation means splitting into dedicated workers per class
// later is a deploy change (different poll queries), not a data migration.

import { randomUUID } from "node:crypto";
import { getPool, type Queryable } from "./pool.js";
import { type UserScope } from "./scope.js";

export const QUEUES = [
  "interactive",
  "ingest",
  "derive",
  "precompute",
  "proactive",
  "reanalysis",
] as const;

export type Queue = typeof QUEUES[number];

export type JobStatus = "pending" | "running" | "done" | "failed";

export type Job<T = unknown> = {
  job_id: string;
  queue: Queue;
  user_id: string;
  payload: T;
  status: JobStatus;
  priority: number;
  created_at: string;
};

// A job in 'running' longer than this has a dead worker holding it. A real ingest
// takes seconds; a few minutes is generous enough to never bite a slow-but-alive
// worker while still recovering promptly from a crash.
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

// Matches the terminal-failure threshold in ingest-worker.ts (migration 022):
// after this many attempts a job stops being retried and goes to 'failed' loudly,
// instead of retrying forever.
const DEFAULT_MAX_ATTEMPTS = 3;

export type ReclaimedJob = {
  job_id: string;
  queue: Queue;
  user_id: string;
  attempts: number;
  outcome: "requeued" | "terminal";
};

function queueLog(level: "warn" | "error", msg: string, fields: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ level, msg, ...fields }) + "\n");
}

/**
 * Reclaim jobs stuck in 'running' past their lease — the fix for the incident
 * where a worker died mid-ingest and its job never came back: no retry, no
 * alert, no way to reclaim it. See migration 023 for the full story.
 *
 * Safe under concurrency: the inner select uses `for update skip locked`, same
 * as dequeue. Two workers racing this at once cannot both reclaim the same row —
 * whichever locks it first wins; the other skips it. Once one worker's update
 * commits, the row is no longer 'running', so a racing reclaim simply matches
 * zero rows instead of double-incrementing `attempts`.
 *
 * Respects migration 022's attempts/terminal-failure contract: a job whose
 * attempts would exceed maxAttempts on this reclaim goes straight to 'failed'
 * (loudly logged) instead of being handed back out to retry forever.
 *
 * Every reclaim is logged — a job stuck in 'running' means a worker died,
 * which is a signal, not routine.
 */
export async function reclaimStuckJobs(
  opts: { queue?: Queue; leaseMs?: number; maxAttempts?: number; db?: Queryable } = {},
): Promise<ReclaimedJob[]> {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const db = opts.db ?? getPool();

  const res = await db.query<{
    job_id: string; queue: string; user_id: string; attempts: number; status: string;
  }>(
    `update jobs set
       status = case when attempts + 1 > $2 then 'failed' else 'pending' end,
       attempts = attempts + 1,
       started_at = null,
       finished_at = case when attempts + 1 > $2 then now() else finished_at end,
       error = case when attempts + 1 > $2
         then 'lease_expired: worker died holding job past its lease and attempts were exhausted'
         else error end
     where job_id in (
       select job_id from jobs
       where status = 'running'
         and ($3::text is null or queue = $3)
         and started_at < now() - make_interval(secs => $1::double precision / 1000.0)
       for update skip locked
     )
     returning job_id, queue, user_id, attempts, status`,
    [leaseMs, maxAttempts, opts.queue ?? null],
  );

  const reclaimed: ReclaimedJob[] = res.rows.map((row) => ({
    job_id: row.job_id,
    queue: row.queue as Queue,
    user_id: row.user_id,
    attempts: row.attempts,
    outcome: row.status === "failed" ? "terminal" : "requeued",
  }));

  for (const job of reclaimed) {
    queueLog(
      job.outcome === "terminal" ? "error" : "warn",
      job.outcome === "terminal" ? "job_reclaim_terminal_failure" : "job_reclaimed",
      {
        job_id: job.job_id,
        queue: job.queue,
        user_id: job.user_id,
        attempts: job.attempts,
        lease_ms: leaseMs,
      },
    );
  }

  return reclaimed;
}

/** Write a job and return immediately. Never blocks the HTTP request. */
export async function enqueue<T = unknown>(
  queue: Queue,
  scope: UserScope,
  payload: T,
  opts: { priority?: number; db?: Queryable } = {},
): Promise<string> {
  const job_id = randomUUID();
  const db = opts.db ?? getPool();
  await db.query(
    `insert into jobs (job_id, queue, user_id, payload, priority)
     values ($1, $2, $3, $4, $5)`,
    [job_id, queue, scope.user_id, JSON.stringify(payload), opts.priority ?? 0],
  );
  return job_id;
}

/**
 * Claim the next pending job in a queue. Returns null if the queue is empty.
 *
 * First reclaims any jobs in this queue stuck in 'running' past their lease
 * (see reclaimStuckJobs) so a dead worker's job becomes claimable again instead
 * of being lost forever. Pass `leaseMs`/`maxAttempts` to override the defaults
 * (e.g. in tests, to make a job's lease expire immediately).
 */
export async function dequeue<T = unknown>(
  queue: Queue,
  db: Queryable = getPool(),
  opts: { leaseMs?: number; maxAttempts?: number } = {},
): Promise<Job<T> | null> {
  await reclaimStuckJobs({ queue, db, leaseMs: opts.leaseMs, maxAttempts: opts.maxAttempts });

  const res = await db.query<{
    job_id: string; queue: string; user_id: string; payload: T;
    status: string; priority: number; created_at: string;
  }>(
    `update jobs set status = 'running', started_at = now()
     where job_id = (
       select job_id from jobs
       where queue = $1 and status = 'pending'
       order by priority desc, created_at
       limit 1
       for update skip locked
     )
     returning job_id, queue, user_id, payload, status, priority, created_at::text`,
    [queue],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  return { ...row, status: row.status as JobStatus, queue: row.queue as Queue };
}

/** Mark a job as done or failed. */
export async function completeJob(
  job_id: string,
  outcome: { status: "done" | "failed"; error?: string },
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update jobs set status = $2, finished_at = now(), error = $3
     where job_id = $1`,
    [job_id, outcome.status, outcome.error ?? null],
  );
}

/**
 * Re-queue a job for retry. Increments the attempt counter and resets status
 * to 'pending'. Callers should also log.
 */
export async function retryJob(
  job_id: string,
  db: Queryable = getPool(),
): Promise<number> {
  const res = await db.query<{ attempts: number }>(
    `update jobs set status = 'pending', attempts = attempts + 1
     where job_id = $1
     returning attempts`,
    [job_id],
  );
  return res.rows[0]?.attempts ?? 0;
}
