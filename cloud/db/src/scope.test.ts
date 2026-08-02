// Unit tests for the scope guard and for identifier/secret generation. No database:
// these are properties of the code, not of a running Postgres.

import { describe, it, expect } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { openUserScope, scopedQuery, UnscopedQueryError } from "./scope.js";
import type { Queryable } from "./pool.js";
import {
  USER_SALT_BYTES,
  newUserSalt,
  newUserId,
  newPairingCode,
  newDeviceToken,
  hashDeviceToken,
  userIdFromDeviceToken,
  deviceTokenHashEquals,
  contactIdForTest,
} from "./ids.js";

/** Records what it was asked, answers nothing. */
function recorder(): Queryable & { calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      calls.push({ text, values: [...values] });
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as QueryResult<R>;
    },
  };
}

const SCOPE = openUserScope("usr_test0001");

describe("UserScope", () => {
  it("cannot be opened on something that is not a user id", () => {
    expect(() => openUserScope("h_8f21a4c0")).toThrow(UnscopedQueryError);
    expect(() => openUserScope("")).toThrow(UnscopedQueryError);
    expect(() => openUserScope("usr_")).toThrow(UnscopedQueryError);
    // A sibling track's id prefix is not a user id either.
    expect(() => openUserScope("dev_demo0001")).toThrow(UnscopedQueryError);
  });
});

describe("scopedQuery refuses anything that could read across users", () => {
  it("rejects a select with no user_id predicate", async () => {
    await expect(
      scopedQuery(recorder(), SCOPE, "select display from relationships", []),
    ).rejects.toThrow(UnscopedQueryError);
  });

  it("rejects a select that filters on something other than $1", async () => {
    await expect(
      scopedQuery(recorder(), SCOPE, "select display from relationships where display = $1", [
        "Maya",
      ]),
    ).rejects.toThrow(UnscopedQueryError);
  });

  it("rejects a query whose $1 is a different user", async () => {
    await expect(
      scopedQuery(recorder(), SCOPE, "select 1 from relationships where user_id = $1", [
        "usr_someoneelse",
      ]),
    ).rejects.toThrow(UnscopedQueryError);
  });

  it("rejects an insert that does not bind user_id from $1", async () => {
    await expect(
      scopedQuery(
        recorder(),
        SCOPE,
        "insert into relationships (contact_id, user_id) values ($2, $1)",
        [SCOPE.user_id, "h_8f21a4c0"],
      ),
    ).rejects.toThrow(UnscopedQueryError);
  });

  it("accepts a scoped select and passes it straight through", async () => {
    const db = recorder();
    await scopedQuery(db, SCOPE, "select 1 from relationships where user_id = $1", [
      SCOPE.user_id,
    ]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.values[0]).toBe(SCOPE.user_id);
  });

  it("accepts a table-qualified predicate", async () => {
    const db = recorder();
    await scopedQuery(
      db,
      SCOPE,
      "select 1 from relationships r where r.user_id = $1",
      [SCOPE.user_id],
    );
    expect(db.calls).toHaveLength(1);
  });

  it("accepts an insert whose first column and first value are the user", async () => {
    const db = recorder();
    await scopedQuery(
      db,
      SCOPE,
      "insert into relationships (user_id, contact_id) values ($1, $2)",
      [SCOPE.user_id, "h_8f21a4c0"],
    );
    expect(db.calls).toHaveLength(1);
  });
});

describe("user_salt", () => {
  it("is at least 32 bytes", () => {
    expect(USER_SALT_BYTES).toBeGreaterThanOrEqual(32);
    expect(newUserSalt()).toHaveLength(32);
  });

  it("is unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(newUserSalt().toString("hex"));
    expect(seen.size).toBe(2000);
  });

  it("is not a low-entropy or constant buffer", () => {
    const salt = newUserSalt();
    expect(new Set(salt).size).toBeGreaterThan(8);
    expect(salt.equals(Buffer.alloc(32))).toBe(false);
  });
});

describe("identifiers", () => {
  it("carry the prefixes CONTRACTS.md section 6 fixes", () => {
    expect(newUserId()).toMatch(/^usr_[A-Za-z0-9_-]{4,}$/);
  });

  it("mints six-digit pairing codes across the full range, zero-padded", () => {
    const codes = Array.from({ length: 5000 }, () => newPairingCode());
    for (const c of codes) expect(c).toMatch(/^[0-9]{6}$/);
    // A generator that skipped the padded low range would never produce one of these.
    expect(codes.some((c) => c.startsWith("0"))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(4000);
  });
});

describe("device tokens", () => {
  it("carry the user id, so authentication never needs an unscoped query", () => {
    const userId = newUserId();
    const { token } = newDeviceToken(userId);
    expect(userIdFromDeviceToken(token)).toBe(userId);
  });

  it("refuse to yield a user id from a malformed token", () => {
    expect(userIdFromDeviceToken("no-dot-here")).toBeNull();
    expect(userIdFromDeviceToken(".secret")).toBeNull();
    expect(userIdFromDeviceToken("h_8f21a4c0.secret")).toBeNull();
  });

  it("compare by hash, and a tampered secret does not match", () => {
    const userId = newUserId();
    const { token, hash } = newDeviceToken(userId);
    expect(deviceTokenHashEquals(hash, hashDeviceToken(token))).toBe(true);
    expect(deviceTokenHashEquals(hash, hashDeviceToken(`${token}x`))).toBe(false);
  });
});

describe("contact_id is per-user by arithmetic", () => {
  it("gives the same person a different id under a different salt", () => {
    const handle = "+15551234567";
    const a = contactIdForTest(newUserSalt(), handle);
    const b = contactIdForTest(newUserSalt(), handle);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^h_[0-9a-f]{16}$/);
  });

  it("is stable for one salt", () => {
    const salt = newUserSalt();
    expect(contactIdForTest(salt, "+15551234567")).toBe(
      contactIdForTest(salt, "+15551234567"),
    );
  });
});
