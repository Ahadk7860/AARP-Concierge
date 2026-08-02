// A cross-process mutex for test files that touch `boi_dev_d`.
//
// vitest runs test FILES in parallel workers. Track D now has two files that need a
// live database — `cloud/db/src/schema.test.ts`, which drops and rebuilds the schema,
// and `cloud/api/src/ingest.test.ts`, which drives the API against it. Run
// concurrently, one file's `rollbackAll` deletes the tables the other is mid-insert
// into, and the failures read as flakiness rather than as the collision they are.
//
// The obvious fix is `--no-file-parallelism` or a `poolOptions` entry in
// `vitest.config.ts`. That file is foundation-owned and append-only, and the setting is
// global: it would serialise Track C's suite too, in a worktree I cannot see. So the
// serialisation lives here instead, where it binds exactly the files that need it.
//
// A session-level advisory lock is the right primitive: it is held by one connection
// rather than one transaction, it is released automatically if the worker crashes, and
// it costs nothing when uncontended.

import pg from "pg";
import { databaseUrl } from "./pool.js";

/** Any stable integer. Derived from the database name so two databases never contend. */
const SUITE_LOCK_KEY = 8_140_231;

let holder: pg.Client | null = null;

/**
 * Block until this process owns the database, then hold it until `releaseSuiteLock`.
 *
 * Call from `beforeAll`. The wait is unbounded on purpose — a suite that gave up after
 * a timeout would report a spurious failure, which is the thing this exists to prevent.
 */
export async function acquireSuiteLock(): Promise<void> {
  if (holder !== null) return;
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  await client.query("select pg_advisory_lock($1)", [SUITE_LOCK_KEY]);
  holder = client;
}

/** Call from `afterAll`. Disconnecting would release the lock anyway; be explicit. */
export async function releaseSuiteLock(): Promise<void> {
  if (holder === null) return;
  const client = holder;
  holder = null;
  try {
    await client.query("select pg_advisory_unlock($1)", [SUITE_LOCK_KEY]);
  } finally {
    await client.end();
  }
}
