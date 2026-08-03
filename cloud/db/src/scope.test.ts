// Unit tests for the scope guard and for identifier/secret generation. No database:
// these are properties of the code, not of a running Postgres.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import {
  unsafeScopeFromUserId,
  scopedQuery,
  stripSqlComments,
  UnscopedQueryError,
  CrossUserResultError,
} from "./scope.js";
import type { Queryable } from "./pool.js";
import {
  newBriefId,
  newDeviceId,
  newDigestId,
  newOutboundMessageId,
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

const SCOPE = unsafeScopeFromUserId("usr_test000000001");

describe("UserScope", () => {
  it("cannot be opened on something that is not a user id", () => {
    expect(() => unsafeScopeFromUserId("h_8f21a4c0")).toThrow(UnscopedQueryError);
    expect(() => unsafeScopeFromUserId("")).toThrow(UnscopedQueryError);
    expect(() => unsafeScopeFromUserId("usr_")).toThrow(UnscopedQueryError);
    // A sibling track's id prefix is not a user id either.
    expect(() => unsafeScopeFromUserId("dev_demo000000001")).toThrow(UnscopedQueryError);
    // And an id whose alphabet the frozen schema rejects.
    expect(() => unsafeScopeFromUserId("usr_has-dash_here")).toThrow(UnscopedQueryError);
  });
});

describe("scopedQuery's SQL text check — a typo catch, not a boundary", () => {
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
        "usr_someoneelse01",
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

/**
 * The result check, which is the half of `scopedQuery` that actually holds.
 *
 * It inspects the rows that came back rather than the SQL that was sent, so it cannot
 * be talked around by rewriting the query. Every bypass of the text check below is
 * caught here — as long as the foreign data comes back in a column named `user_id`.
 */
function returning(rows: Array<Record<string, unknown>>): Queryable {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
      return { rows: rows as R[], rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}

describe("scopedQuery's result check", () => {
  it("throws when a row belongs to another user", async () => {
    await expect(
      scopedQuery(
        returning([{ user_id: "usr_someoneelse01", display: "Maya" }]),
        SCOPE,
        "select b.user_id from relationships a join relationships b on a.display = b.display where a.user_id = $1",
        [SCOPE.user_id],
      ),
    ).rejects.toThrow(CrossUserResultError);
  });

  it("passes rows that belong to the scope", async () => {
    const res = await scopedQuery(
      returning([{ user_id: SCOPE.user_id, display: "Maya" }]),
      SCOPE,
      "select user_id, display from relationships where user_id = $1",
      [SCOPE.user_id],
    );
    expect(res.rows).toHaveLength(1);
  });
});

/**
 * The known bypasses, pinned in executable form.
 *
 * These exist so the boundary is documented by tests rather than by a comment that
 * drifts. Two are caught by comment-stripping or the result check; the last is NOT
 * caught by anything in this layer, and that is recorded here deliberately rather than
 * papered over. See the header of scope.ts and `## Deviations` in NOTES.md.
 */
describe("scopeLeakRegressions", () => {
  it("strips comments, so a predicate hidden in one no longer satisfies the check", async () => {
    expect(stripSqlComments("select user_id from t -- user_id = $1")).not.toMatch(
      /user_id\s*=\s*\$1/,
    );
    await expect(
      scopedQuery(
        recorder(),
        SCOPE,
        "select user_id, display from relationships -- user_id = $1",
        [SCOPE.user_id],
      ),
    ).rejects.toThrow(UnscopedQueryError);

    await expect(
      scopedQuery(
        recorder(),
        SCOPE,
        "select user_id from relationships /* user_id = $1 */",
        [SCOPE.user_id],
      ),
    ).rejects.toThrow(UnscopedQueryError);
  });

  it("catches `or true` at the result, since the text check cannot see it", async () => {
    // The SQL passes the text check — `user_id = $1` really is in there.
    const sql = "select user_id from relationships where user_id = $1 or true";
    await expect(
      scopedQuery(returning([{ user_id: "usr_someoneelse01" }]), SCOPE, sql, [SCOPE.user_id]),
    ).rejects.toThrow(CrossUserResultError);
  });

  it("DOES NOT catch a leak in a column other than user_id — known and unclosed", async () => {
    // A self-join projecting only the other user's display name. The text check passes,
    // and the result check has no user_id column to inspect. Nothing short of parsing
    // the SQL, or Postgres RLS under a non-superuser role, closes this.
    const res = await scopedQuery(
      returning([{ display: "somebody else's contact" }]),
      SCOPE,
      "select b.display from relationships a join relationships b on a.display = b.display where a.user_id = $1",
      [SCOPE.user_id],
    );
    expect(res.rows).toHaveLength(1);
    // Asserted so that if this layer is ever strengthened, this test fails and forces
    // the claim in cloud/db/README.md to be updated with it.
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

/**
 * The regression that matters most in this file.
 *
 * The patterns are read out of `contracts/schema/*.json` at run time rather than
 * copied here, so this test follows the frozen contract instead of a stale duplicate
 * of it. The original generator used `randomBytes(9).toString("base64url")`, whose
 * alphabet includes `-` and `_`; roughly one id in three violated
 * `^usr_[0-9a-zA-Z]{8,32}$` and nothing local noticed, because both the SQL CHECK and
 * the scope regex were written with the same looser alphabet and no stored payload is
 * validated against its schema. One thousand samples puts the odds of a
 * one-in-three defect surviving this test at effectively zero.
 */
describe("generated ids satisfy the frozen JSON Schemas", () => {
  const SAMPLES = 1000;

  function patternFrom(schemaFile: string, ...path: string[]): RegExp {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), "contracts", "schema", schemaFile), "utf8"),
    ) as Record<string, unknown>;
    let node: unknown = schema;
    for (const key of path) {
      node = (node as Record<string, unknown>)[key];
      expect(node, `${schemaFile} has no ${path.join(".")}`).toBeDefined();
    }
    const pattern = (node as { pattern?: string }).pattern;
    expect(pattern, `${schemaFile} ${path.join(".")} has no pattern`).toBeDefined();
    return new RegExp(pattern!);
  }

  it.each([
    ["user_id", () => newUserId(), () => patternFrom("digest.v1.json", "properties", "user_id")],
    ["device_id", () => newDeviceId(), () => patternFrom("digest.v1.json", "properties", "device_id")],
  ])("%s matches the frozen pattern across %#", (label, make, getPattern) => {
    const re = getPattern();
    const bad: string[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const id = make();
      if (!re.test(id)) bad.push(id);
    }
    expect(bad, `${label}: ${bad.length}/${SAMPLES} failed ${re.source}`).toEqual([]);
  });

  it("contact ids match the frozen pattern", () => {
    const re = patternFrom("digest.v1.json", "$defs", "relationship", "properties", "contact_id");
    const bad: string[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const id = contactIdForTest(newUserSalt(), `+1555${i}`);
      if (!re.test(id)) bad.push(id);
    }
    expect(bad).toEqual([]);
  });

  it("uses no character outside each id's contract alphabet", () => {
    // The specific defect, named: base64url's `-` and `_` are not in [0-9a-zA-Z].
    for (let i = 0; i < SAMPLES; i += 1) {
      expect(newUserId().slice(4)).not.toMatch(/[-_]/);
      expect(newDeviceId().slice(4)).not.toMatch(/[-_]/);
      expect(newOutboundMessageId().slice(5)).not.toMatch(/[-_]/);
      expect(newBriefId().slice(4)).toMatch(/^[0-9a-f]+$/);
      expect(newDigestId().slice(4)).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("draws uniformly enough that no alphabet character is unreachable", () => {
    // Rejection sampling, not `% 62`. A modulo-biased generator would still pass the
    // pattern tests above, so bias needs its own check.
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLES; i += 1) for (const ch of newUserId().slice(4)) seen.add(ch);
    expect(seen.size).toBe(62);
  });
});

describe("identifiers", () => {
  it("carry the prefixes CONTRACTS.md section 6 fixes", () => {
    expect(newUserId()).toMatch(/^usr_[0-9a-zA-Z]{8,32}$/);
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

  it("refuses a prefix outside the frozen alphabet, rather than passing it on", () => {
    // The last survivor of the base64url defect. This parser accepted
    // `[A-Za-z0-9_-]{4,}`, so these returned a "user id" that `unsafeScopeFromUserId`
    // then threw on — a 500 for a garbage bearer token, where the answer is 401.
    for (const bad of [
      "usr_has-dash_here.secret",
      "usr_short.secret",
      `usr_${"x".repeat(33)}.secret`,
      "usr_.secret",
    ]) {
      expect(userIdFromDeviceToken(bad), bad).toBeNull();
      // And the two functions agree: whatever the parser accepts, the scope opens.
      expect(() => unsafeScopeFromUserId(bad.split(".")[0]!)).toThrow(UnscopedQueryError);
    }
  });

  it("agrees with unsafeScopeFromUserId on 1000 real tokens", () => {
    // The parser and the scope constructor must accept exactly the same set. They did
    // not, and nothing compared them.
    for (let i = 0; i < 1000; i += 1) {
      const userId = newUserId();
      const parsed = userIdFromDeviceToken(newDeviceToken(userId).token);
      expect(parsed).toBe(userId);
      expect(unsafeScopeFromUserId(parsed!).user_id).toBe(userId);
    }
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
