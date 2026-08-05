// Connection pool for Track D's database.
//
// The database name is per-track (CONTRACTS.md section 9: `boi_dev_d`). Nothing here
// falls back to a framework default -- another track running right now would pick the
// same one and the failures would read as flaky tests rather than as a collision.

import pg from "pg";

export type Queryable = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
};

const DEFAULT_URL = "postgres://localhost:5432/boi_dev_d";

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_URL;
}

let pool: pg.Pool | null = null;

/**
 * Install the one process-wide pool before any repository function is called.
 *
 * Production composition owns the pool lifecycle. Repositories intentionally keep
 * their default `getPool()` arguments, but this seam makes those defaults resolve to
 * the exact resource whose URL, readiness, and shutdown the runtime controls.
 * Replacing a live pool would split readiness from request traffic, so refuse it.
 */
export function installPool(next: pg.Pool): void {
  if (pool !== null && pool !== next) {
    throw new Error("database_pool_already_installed");
  }
  pool = next;
}

/** True only when `candidate` is the pool repository defaults will use. */
export function isInstalledPool(candidate: pg.Pool): boolean {
  return pool === candidate;
}

export function getPool(): pg.Pool {
  if (pool === null) {
    pool = new pg.Pool({ connectionString: databaseUrl(), max: 8 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (tx: Queryable) => Promise<T>,
  from: pg.Pool = getPool(),
): Promise<T> {
  const client = await from.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
