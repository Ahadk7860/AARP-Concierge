import type { Phase2PrivateRepository } from "../db/src/repository.js";

export type RetentionLogEvent = {
  msg: "turns.retention.purged" | "turns.retention.failed";
  count?: number;
};

export interface RetentionSchedule {
  install(job: () => Promise<void>): () => void;
}

/** Concrete daily schedule; runtime composition owns its lifecycle via the returned stop. */
export class IntervalRetentionSchedule implements RetentionSchedule {
  constructor(
    private readonly onError: (error: TurnRetentionError) => void,
    private readonly intervalMs = 24 * 60 * 60 * 1_000,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("retention_interval_invalid");
  }

  install(job: () => Promise<void>): () => void {
    const timer = setInterval(() => {
      void job().catch((error: unknown) => {
        this.onError(error instanceof TurnRetentionError ? error : new TurnRetentionError());
      });
    }, this.intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

export class TurnRetentionError extends Error {
  constructor() { super("turn_retention_failed"); }
}

/** Idempotent, concurrency-coalesced purge with operational-only observability. */
export class TurnRetentionWorker {
  private running: Promise<number> | null = null;

  constructor(private readonly options: {
    repository: Pick<Phase2PrivateRepository, "purgeExpiredTurns">;
    now?: () => Date;
    observe: (event: RetentionLogEvent) => void;
  }) {}

  run(): Promise<number> {
    if (this.running !== null) return this.running;
    const execution = this.execute();
    this.running = execution;
    void execution.finally(() => {
      if (this.running === execution) this.running = null;
    }).catch(() => { /* the caller observes the original rejection */ });
    return execution;
  }

  private async execute(): Promise<number> {
    try {
      const now = this.options.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error("invalid clock");
      const count = await this.options.repository.purgeExpiredTurns(now);
      this.options.observe({ msg: "turns.retention.purged", count });
      return count;
    } catch {
      this.options.observe({ msg: "turns.retention.failed" });
      throw new TurnRetentionError();
    }
  }
}

/** Installs the purge job into platform-owned scheduling without choosing a scheduler. */
export function scheduleTurnRetention(worker: TurnRetentionWorker, schedule: RetentionSchedule): () => void {
  return schedule.install(async () => { await worker.run(); });
}
