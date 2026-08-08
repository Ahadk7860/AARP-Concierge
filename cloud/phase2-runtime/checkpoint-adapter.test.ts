import { describe, expect, it } from "vitest";
import { PostgresStreamCheckpoint } from "./checkpoint-adapter.js";
import type { QueryResult } from "pg";
import type { Queryable } from "../db/src/pool.js";

function fakeDb(): Queryable & { queries: string[]; rows: unknown[] } {
  const db = {
    queries: [] as string[],
    rows: [] as unknown[],
    async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      db.queries.push(sql);
      const rows = db.rows as R[];
      db.rows = [];
      return {
        rows,
        command: "SELECT",
        rowCount: rows.length,
        oid: 0,
        fields: [],
      } as QueryResult<R>;
    },
  };
  return db;
}

describe("checkpoint-adapter", () => {
  it("load returns null when no row exists", async () => {
    const db = fakeDb();
    const checkpoint = new PostgresStreamCheckpoint(db, "usr_test");
    const cursor = await checkpoint.load();
    expect(cursor).toBeNull();
  });

  it("load returns the stored cursor", async () => {
    const db = fakeDb();
    db.rows.push({ cursor: "evt_abc123" });
    const checkpoint = new PostgresStreamCheckpoint(db, "usr_test");
    const cursor = await checkpoint.load();
    expect(cursor).toBe("evt_abc123");
  });

  it("save upserts the cursor", async () => {
    const db = fakeDb();
    const checkpoint = new PostgresStreamCheckpoint(db, "usr_test");
    await checkpoint.save({ event_id: "evt_1", cursor: "c_1" });
    expect(db.queries[0]).toContain("insert into stream_checkpoints");
    expect(db.queries[0]).toContain("on conflict");
    db.rows.push({ cursor: "c_1" });
    const loaded = await checkpoint.load();
    expect(loaded).toBe("c_1");
  });
});
