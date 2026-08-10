// Ingest worker — dequeues from the "ingest" queue and calls insertDigest.
//
// BLOCKING 2 fix: the ingest route enqueued jobs but nothing ever dequeued them.
// This worker runs in the same process at <1k users; the queue column means
// splitting to a dedicated process later is a deploy change.

import { getPool, type Queryable } from "./pool.js";
import { dequeue, completeJob, retryJob } from "./queue.js";
import { insertDigest, latestDigest, DuplicateDigestError } from "./repository.js";
import { deriveV3FromDigest } from "./derive-v3.js";
import { unsafeScopeFromUserId } from "./scope.js";
import type { Digest, DigestV2, OutboundMessage, SendResult } from "../../shared/src/contracts.js";

export type IngestWorkerDeps = {
  /** Optional channel for first-sync-offer sends. Only `send` is used. */
  channel?: { send: (msg: OutboundMessage) => Promise<SendResult> };
  pollIntervalMs?: number;
  db?: Queryable;
};

type IngestJobPayload = {
  digest_id: string;
  digest: Digest | DigestV2;
  first: boolean;
  received_at: string;
};

/**
 * Process one ingest job. Returns true if a job was processed, false if the queue
 * was empty. Throws on transient errors (callers retry); completes jobs as done/failed.
 */
export async function processOneIngestJob(
  deps: IngestWorkerDeps = {},
): Promise<boolean> {
  const db = deps.db ?? getPool();
  const job = await dequeue<IngestJobPayload>("ingest", db);
  if (job === null) return false;

  const scope = unsafeScopeFromUserId(job.user_id);

  try {
    const { digest_id, digest } = job.payload;

    // Re-derive `first` from actual state — the enqueued flag may be stale.
    const existing = await latestDigest(scope);
    const first = existing === null;

    await insertDigest(scope, { digest_id, digest });

    // Populate the v3 person-centric tables (persons/identities/interactions/
    // relationship_metrics_daily) that PostgresAgentStore reads. Deliberately its own
    // transaction, deliberately swallowed on failure — see derive-v3.ts's file header
    // for why: the digest itself must never be lost to a bug in this newer, less
    // exercised derivation path. A failure here leaves the v3 cache stale until the
    // next digest, not the digest ingest failed or retried forever (a retry would hit
    // DuplicateDigestError on insertDigest and never reach derivation again).
    try {
      await deriveV3FromDigest(scope, { digest_id, digest });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "v3_derivation_failed",
          job_id: job.job_id,
          user_id: job.user_id,
          digest_id,
          error: errorMsg,
        }) + "\n",
      );
    }

    // First sync offer — same as the old inline path, but async now.
    if (first && deps.channel !== undefined) {
      // Import lazily to avoid circular dependency between db and api packages.
      const { firstSyncOffer } = await import("../../api/src/welcome.js");
      try {
        await deps.channel.send(firstSyncOffer(scope.user_id, digest));
      } catch {
        // Offer failure must not fail the job (same as old path).
      }
    }

    await completeJob(job.job_id, { status: "done" }, db);
    return true;
  } catch (err) {
    if (err instanceof DuplicateDigestError) {
      // Duplicate is not a failure — mark done.
      await completeJob(job.job_id, { status: "done" }, db);
      return true;
    }

    const maxAttempts = 3;
    const attempt = await retryJob(job.job_id, db);
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (attempt > maxAttempts) {
      // Terminal — no more retries. Emit a loud log/metric.
      await completeJob(
        job.job_id,
        { status: "failed", error: errorMsg },
        db,
      );
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "ingest_job_terminal_failure",
          job_id: job.job_id,
          user_id: job.user_id,
          attempts: attempt,
          error: errorMsg,
        }) + "\n",
      );
    }

    // Don't throw — transient retries are re-queued (status='pending'),
    // terminal failures are logged. The poll loop continues either way.
    return true;
  }
}

/**
 * Start a polling loop that processes ingest jobs until stopped.
 * Returns a stop function. At <1k users polling is correct; at scale,
 * switch to LISTEN/NOTIFY or a dedicated worker process.
 */
export function startIngestWorker(deps: IngestWorkerDeps = {}): () => Promise<void> {
  const intervalMs = deps.pollIntervalMs ?? 5000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      for (let i = 0; i < 50; i++) {
        const hadWork = await processOneIngestJob(deps);
        if (!hadWork) break;
      }
    } catch {
      // Transient error — retry next interval.
    }
    if (!stopped) {
      timer = setTimeout(poll, intervalMs);
    }
  }

  timer = setTimeout(poll, 0);
  return async () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
