// Forward-only migration runner.
//
// Idempotent by two independent mechanisms, because either alone has a hole:
//   1. `schema_migrations` records what has run, so a re-run is a no-op.
//   2. Every statement in every migration is itself `if not exists`, so a run against
//      a database whose ledger was lost still converges instead of erroring.
//
// A migration whose checksum no longer matches what was applied is an error, not a
// silent re-apply. Forward-only means editing an applied migration is a mistake.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, type Queryable } from "./pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The migrations are `.sql` files, so `tsc` does not copy them into `dist/`. Walk up
 * to the repo root and read them from the source tree, so the runner behaves the same
 * whether it was loaded from `cloud/db/src` or from `dist/cloud/db/src`.
 */
function findMigrationsDir(): string {
  const sibling = join(HERE, "..", "migrations");
  if (existsSync(sibling)) return sibling;

  let dir = HERE;
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, "cloud", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate cloud/db/migrations from ${HERE}`);
}

export const MIGRATIONS_DIR = findMigrationsDir();

export type Migration = { version: string; sql: string; checksum: string };

/** Up migrations only, sorted by version. `*.down.sql` is never applied by this runner. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".sql") && !n.endsWith(".down.sql"))
    .sort();

  const out: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), "utf8");
    out.push({
      version: name.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return out;
}

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function migrate(
  db: Queryable = getPool(),
  dir: string = MIGRATIONS_DIR,
): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  // The ledger lives in 001, so the very first run has nowhere to look yet.
  await db.query(`
    create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);

  for (const m of migrations) {
    const seen = await db.query<{ checksum: string }>(
      "select checksum from schema_migrations where version = $1",
      [m.version],
    );
    const row = seen.rows[0];
    if (row !== undefined) {
      if (row.checksum !== m.checksum) {
        throw new Error(
          `migration ${m.version} changed after it was applied ` +
            `(recorded ${row.checksum.slice(0, 12)}, on disk ${m.checksum.slice(0, 12)}). ` +
            `Migrations are forward-only: add a new one.`,
        );
      }
      skipped.push(m.version);
      continue;
    }

    await db.query(m.sql);
    await db.query(
      "insert into schema_migrations (version, checksum) values ($1, $2)",
      [m.version, m.checksum],
    );
    applied.push(m.version);
  }

  return { applied, skipped };
}

/**
 * Tear the schema back down, newest first. Used by tests that need a genuinely empty
 * database; not wired to a CLI flag, because a one-keystroke drop of a real database
 * is the kind of convenience that eventually gets used.
 */
export async function rollbackAll(
  db: Queryable = getPool(),
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".down.sql")).sort().reverse();
  const run: string[] = [];
  for (const name of names) {
    await db.query(await readFile(join(dir, name), "utf8"));
    run.push(name);
  }
  return run;
}

// `node --experimental-strip-types cloud/db/src/migrate.ts`
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const pool = getPool();
  try {
    const result = await migrate(pool);
    process.stdout.write(
      `${JSON.stringify({ level: "info", msg: "migrate", ...result })}\n`,
    );
  } finally {
    await pool.end();
  }
}
