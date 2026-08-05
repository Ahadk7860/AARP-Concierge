// Railway pre-deploy migration entrypoint. Multiple services may release the same
// commit concurrently, so the migration ledger is protected by a session advisory lock.

import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate, type MigrateResult } from "./migrate.js";
import { closePool, installPool, type Queryable } from "./pool.js";

/** Stable, repository-specific signed bigint; sent as text to avoid JS precision loss. */
export const DEPLOY_MIGRATION_LOCK = "-6624340948319657721";

type MigrationClient = Queryable & { release(): void };
type MigrationPool = { connect(): Promise<MigrationClient> };

export async function runDeployMigrations(
  pool: MigrationPool,
  runner: (db: Queryable) => Promise<MigrateResult> = migrate,
): Promise<MigrateResult> {
  const client = await pool.connect();
  let locked = false;
  let result: MigrateResult | undefined;
  let primary: unknown;
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [DEPLOY_MIGRATION_LOCK]);
    locked = true;
    result = await runner(client);
  } catch (error) {
    primary = error;
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock($1::bigint)", [DEPLOY_MIGRATION_LOCK]);
      } catch (error) {
        primary ??= error;
      }
    }
    try { client.release(); } catch (error) { primary ??= error; }
  }
  if (primary !== undefined) throw primary;
  if (result === undefined) throw new Error("migration_runner_returned_no_result");
  return result;
}

export function deployDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env["DATABASE_URL"]?.trim();
  if (!value) throw new Error("DATABASE_URL is required for deployment migrations");
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres for deployment migrations");
  }
  return value;
}

export async function deployMigrations(
  env: NodeJS.ProcessEnv = process.env,
  createPool: (url: string) => pg.Pool = (url) => new pg.Pool({ connectionString: url, max: 2 }),
): Promise<MigrateResult> {
  const pool = createPool(deployDatabaseUrl(env));
  let installed = false;
  try {
    installPool(pool);
    installed = true;
    return await runDeployMigrations(pool);
  } finally {
    if (installed) await closePool();
    else await pool.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await deployMigrations();
  process.stdout.write(`${JSON.stringify({ level: "info", msg: "deploy.migrate", ...result })}\n`);
}
