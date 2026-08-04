// The sweep: who is due, and deliver to each of them.
//
// **This is the wiring the whole retention product was missing.** `dueUsers()`, `isDue()`,
// `slotFor()`, `nextRetry()` and `runForUser()` were correct, tested, timezone-aware and
// idempotent — and searching the non-test cloud source for a caller of any of them
// returned only their own definitions. `node-cron` was a dependency and appeared in
// production code exactly once, in a comment. Nothing woke at 8am.
//
// It is the same failure Track E named one level down at `TickDeps` — "a type with no
// producer cannot be wrong" — repeated one level up. `BOI_BRIEF.md`: "Ranking is
// acquisition. **The daily brief is retention.**" Retention was a library.
//
// The logic is all downstairs and stays there. This file is a loop with a bound on it.

import {
  allUserSchedules,
  type UserScope,
} from "../../db/src/index.js";
import { dueUsers, type UserSchedule } from "../../brief/src/scheduler.js";
import { runForUserWithRetry, type TickDeps, type TickOutcome } from "../../brief/src/run.js";

export type SweepDeps = Omit<TickDeps, "now"> & {
  /**
   * How many users are delivered to at once.
   *
   * Bounded because the tick spawns Python and talks to a transport: unbounded fan-out
   * over a fleet is a self-inflicted denial of service on the day it finally has users.
   */
  concurrency?: number;
  /** Injected so a test can drive a fixed population without writing rows it does not need. */
  schedules?: () => Promise<UserSchedule[]>;
};

export type SweepResult = {
  now: string;
  considered: number;
  due: number;
  outcomes: TickOutcome[];
  sent: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

export const DEFAULT_CONCURRENCY = 8;

/**
 * One pass. Everyone whose local morning it is, delivered to, once.
 *
 * **One user's failure never blocks another's**, which is why every tick is wrapped
 * individually. `runForUserWithRetry` already catches what the tick throws; this catches
 * what happens BEFORE it — a scope that cannot be built, a database hiccup on the read
 * side — because a sweep that dies on user three leaves users four through four hundred
 * with no morning and nothing in the log saying why.
 */
export async function sweepOnce(now: Date, deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const schedules = deps.schedules ? await deps.schedules() : await allUserSchedules();
  const due = dueUsers(now, schedules);

  log({
    msg: "sweep.start",
    now: now.toISOString(),
    considered: schedules.length,
    due: due.length,
  });

  const outcomes: TickOutcome[] = [];
  const queue = [...due];
  const workers = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, queue.length));

  async function worker(): Promise<void> {
    for (;;) {
      const schedule = queue.shift();
      if (schedule === undefined) return;
      try {
        const outcome = await runForUserWithRetry(schedule, { ...deps, now });
        outcomes.push(outcome);
        log({
          msg: `sweep.user_${outcome.status}`,
          user_id: schedule.user_id,
          timezone: schedule.timezone,
          ...("reason" in outcome ? { reason: outcome.reason } : {}),
          ...("brief_id" in outcome ? { brief_id: outcome.brief_id } : {}),
        });
      } catch (err) {
        // Reached only if the tick throws outside its own retry wrapper. Recorded as a
        // failed outcome rather than swallowed, so the sweep's own counts stay honest.
        outcomes.push({
          user_id: schedule.user_id,
          status: "failed",
          attempt: 1,
          next_attempt_at: null,
        });
        log({
          msg: "sweep.user_error",
          level: "error",
          user_id: schedule.user_id,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  const result: SweepResult = {
    now: now.toISOString(),
    considered: schedules.length,
    due: due.length,
    outcomes,
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    durationMs: Date.now() - started,
  };

  log({
    msg: "sweep.done",
    now: result.now,
    due: result.due,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    already_sent: outcomes.filter((o) => o.status === "already_sent").length,
    duration_ms: result.durationMs,
  });
  return result;
}

export type { UserScope };
