// One sweep at a time, across every process that thinks it is the scheduler.
//
// The database already makes a double-send impossible: `briefs` has
// `unique (user_id, scheduled_for)`, so a second instance composing the same morning
// loses on insert and `runForUser` short-circuits on `already_settled`. **Safe and quiet
// are different things.** A duplicate silently absorbed by a constraint is a duplicate
// nobody learns about — two schedulers running for a month look exactly like one
// scheduler running for a month, until the day they disagree about the clock and a user
// gets two morning texts.
//
// So the lock exists to make the collision VISIBLE. The loser does not sweep, and says so
// with the same seriousness as a failure.

import pg from "pg";
import { databaseUrl } from "../../db/src/pool.js";

/**
 * Any stable integer, and deliberately not the suite lock's (`8_140_231`).
 *
 * A session-level advisory lock rather than a row: it is held by a connection rather than
 * a transaction, and Postgres releases it when that connection dies — which is what a
 * scheduler that was `kill -9`ed needs. A lock table would need a lease, a heartbeat and
 * a reaper, all of which are ways to get this wrong.
 */
export const SCHEDULER_LOCK_KEY = 8_140_777;

export type SchedulerLock = {
  readonly held: boolean;
  release(): Promise<void>;
};

/**
 * Try to become the sweeping instance. Never blocks.
 *
 * `pg_try_advisory_lock` and not `pg_advisory_lock`: waiting would make the loser sweep
 * late instead of not at all, which is worse — it would run after the winner had already
 * sent, against a database the winner has already changed, and every log line would say
 * it did nothing for reasons that look like a quiet morning.
 */
export async function acquireSchedulerLock(
  connectionString = databaseUrl(),
): Promise<SchedulerLock> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const res = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [SCHEDULER_LOCK_KEY],
  );
  const held = res.rows[0]?.locked === true;
  if (!held) {
    await client.end();
    return { held: false, release: async () => {} };
  }
  return {
    held: true,
    release: async () => {
      // Unlock explicitly before ending: the connection may be pooled by a caller that
      // reuses it, and an advisory lock outliving its intended scope is a scheduler that
      // never sweeps again.
      await client.query("select pg_advisory_unlock($1)", [SCHEDULER_LOCK_KEY]);
      await client.end();
    },
  };
}
