import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getPool, isInstalledPool, type Queryable } from "./pool.js";

import {
  DEPLOY_MIGRATION_LOCK,
  deployMigrations,
  deployDatabaseUrl,
  runDeployMigrations,
} from "./deploy.js";

type FakeClient = Queryable & { release(): void };

describe("deployment migration configuration", () => {
  it("requires an explicit postgres URL", () => {
    expect(() => deployDatabaseUrl({})).toThrow(/DATABASE_URL is required/);
    expect(() => deployDatabaseUrl({ DATABASE_URL: "https://example.com" })).toThrow(/postgres/);
    expect(deployDatabaseUrl({ DATABASE_URL: "postgresql://db/boi" }))
      .toBe("postgresql://db/boi");
  });

  it("installs and closes the exact pool used by the migration runner", async () => {
    let ended = 0;
    let pool!: Pool;
    const client: FakeClient = {
      query: (async () => {
        expect(getPool()).toBe(pool);
        return { rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
      }) as Queryable["query"],
      release: () => {},
    };
    pool = {
      connect: async () => client,
      end: async () => { ended += 1; },
    } as unknown as Pool;
    const result = await deployMigrations(
      { DATABASE_URL: "postgres://db/boi" },
      () => pool,
    );
    expect(result.applied.length).toBeGreaterThan(0);
    expect(ended).toBe(1);
    expect(isInstalledPool(pool)).toBe(false);
  });
});

describe("advisory-locked deployment migrations", () => {
  it("holds the lock around migration and releases the session", async () => {
    const events: string[] = [];
    const client: FakeClient = {
      query: (async (sql: string, values?: readonly unknown[]) => {
        events.push(`${sql.includes("unlock") ? "unlock" : "lock"}:${String(values?.[0])}`);
        return { rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
      }) as Queryable["query"],
      release: () => { events.push("release"); },
    };
    const result = await runDeployMigrations(
      { connect: async () => client },
      async (received) => {
        expect(received).toBe(client);
        events.push("migrate");
        return { applied: ["012"], skipped: [] };
      },
    );
    expect(result.applied).toEqual(["012"]);
    expect(events).toEqual([
      `lock:${DEPLOY_MIGRATION_LOCK}`,
      "migrate",
      `unlock:${DEPLOY_MIGRATION_LOCK}`,
      "release",
    ]);
  });

  it("serializes two concurrent service deploys", async () => {
    let owner = false;
    let wake: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const client = (): FakeClient => ({
      query: (async (sql: string) => {
        if (!sql.includes("unlock")) {
          while (owner) await new Promise<void>((resolve) => { wake = resolve; });
          owner = true;
        } else {
          owner = false;
          wake?.();
          wake = undefined;
        }
        return { rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
      }) as Queryable["query"],
      release: () => {},
    });
    const pool = { connect: async () => client() };
    const runner = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { applied: [], skipped: ["001"] };
    };
    await Promise.all([runDeployMigrations(pool, runner), runDeployMigrations(pool, runner)]);
    expect(maxActive).toBe(1);
  });

  it("unlocks and releases after a migration error while preserving that error", async () => {
    const events: string[] = [];
    const migrationError = new Error("migration failed");
    const client: FakeClient = {
      query: (async (sql: string) => {
        events.push(sql.includes("unlock") ? "unlock" : "lock");
        if (sql.includes("unlock")) throw new Error("secondary unlock failure");
        return { rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
      }) as Queryable["query"],
      release: () => { events.push("release"); },
    };
    await expect(runDeployMigrations(
      { connect: async () => client },
      async () => { throw migrationError; },
    )).rejects.toBe(migrationError);
    expect(events).toEqual(["lock", "unlock", "release"]);
  });
});
