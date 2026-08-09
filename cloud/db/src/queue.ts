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

/** Claim the next pending job in a queue. Returns null if the queue is empty. */
export async function dequeue<T = unknown>(
  queue: Queue,
  db: Queryable = getPool(),
): Promise<Job<T> | null> {
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
