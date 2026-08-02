// The user scope, and the guards around it.
//
// WHAT THIS LAYER ACTUALLY GUARANTEES, stated precisely, because an overstated
// security claim is worse than none — it stops people looking for the real control.
//
//   1. TYPES — strong. `UserScope` is branded, so it cannot be built from a bare
//      string and cannot be defaulted. Every repository method takes one as its first
//      argument, so `npm run typecheck` fails on a call that omits the user. This is
//      airtight against FORGETTING to scope a query.
//
//   2. RESULT VERIFICATION — strong for what it covers. Every row a scoped query
//      returns is checked: if any row carries a `user_id` that is not the scope's, the
//      call throws. This catches the cases the SQL text check misses — a self-join, an
//      `or true`, a predicate hidden in a comment — because it inspects what came back
//      rather than what was asked.
//
//   3. SQL TEXT CHECK — WEAK. A regex, and it is defeatable by construction. It exists
//      to catch typos and copy-paste, not attackers. Do not treat it as a boundary.
//
// The hole that remains, and it is a real one: a query can return another user's data
// in columns OTHER than `user_id` — `select b.display from relationships a join
// relationships b on a.display = b.display where a.user_id = $1` leaks display names
// and no guard here sees it. Nothing short of parsing the SQL, or Postgres row-level
// security under a non-superuser role, closes that. `scopeLeakRegressions` in
// scope.test.ts pins the known bypasses so the boundary is documented in executable
// form rather than in a comment that drifts.
//
// AND THE BIGGER ONE: `unsafeScopeFromUserId` accepts any well-formed id. A scope
// proves you named A user, never that you named the AUTHORIZED user. Authorization is
// an HTTP-layer obligation. See the warning on that function.

import type { Queryable } from "./pool.js";
import type { QueryResult, QueryResultRow } from "pg";

declare const scopeBrand: unique symbol;

export type UserScope = {
  readonly user_id: string;
  readonly [scopeBrand]: true;
};

/** Exactly `contracts/schema/digest.v1.json`'s `^usr_[0-9a-zA-Z]{8,32}$`. */
const USER_ID_RE = /^usr_[0-9a-zA-Z]{8,32}$/;

export class UnscopedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnscopedQueryError";
  }
}

export class CrossUserResultError extends Error {
  constructor(readonly expected: string, readonly found: string) {
    super(`query returned a row belonging to ${found}, not ${expected}`);
    this.name = "CrossUserResultError";
  }
}

/**
 * Build a scope from a user id.
 *
 * ⚠️ **This does not authorize anything.** It validates the SHAPE of an id and nothing
 * else. A scope built from an id that arrived in a request path or body confers
 * exactly the access the caller asked for, which is an IDOR:
 *
 * ```ts
 * // WRONG — deletes whoever the caller names, and it typechecks.
 * await deleteUser(unsafeScopeFromUserId(req.params.user_id));
 *
 * // RIGHT — the scope comes from the credential, and the path must match it.
 * const auth = await bootstrapLookups.authenticateDeviceToken(token);
 * if (auth === null || auth.scope.user_id !== req.params.user_id) return unauthorized();
 * await deleteUser(auth.scope);
 * ```
 *
 * The safe sources of a scope are `bootstrapLookups.authenticateDeviceToken`,
 * `bootstrapLookups.resolvePairingCode`, and `createUser`. Everything else is this
 * function, and every call to it is a place a reviewer should stop and check.
 */
export function unsafeScopeFromUserId(userId: string): UserScope {
  if (!USER_ID_RE.test(userId)) {
    throw new UnscopedQueryError(
      `not a user id (expected ${USER_ID_RE.source}): ${JSON.stringify(userId)}`,
    );
  }
  return { user_id: userId } as UserScope;
}

/** `user_id = $1`, allowing whitespace and an optional table qualifier. */
const SCOPE_PREDICATE_RE = /\b(?:[a-z_]+\.)?user_id\s*=\s*\$1\b/i;

/**
 * Inserts cannot carry a WHERE clause, so the equivalent check is structural:
 * `user_id` must be the FIRST column and `$1` the FIRST value.
 */
const INSERT_COLUMNS_RE = /\binsert\s+into\s+[\w".]+\s*\(\s*user_id\b/i;
const INSERT_VALUES_RE = /\bvalues\s*\(\s*\$1\b/i;

/**
 * Strip `--` line comments and `/* *\/` blocks before matching.
 *
 * Without this, `select user_id, display from relationships -- user_id = $1` satisfies
 * the predicate check using text the database never executes.
 */
export function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Weak by construction — see the header. A typo catch, not a boundary. */
function looksScoped(text: string): boolean {
  const sql = stripSqlComments(text);
  if (SCOPE_PREDICATE_RE.test(sql)) return true;
  return INSERT_COLUMNS_RE.test(sql) && INSERT_VALUES_RE.test(sql);
}

function hasUserId(row: unknown): row is { user_id: unknown } {
  return typeof row === "object" && row !== null && "user_id" in row;
}

/**
 * Run a query confined to one user, then verify the rows that came back.
 *
 * The result check is the half that holds. It cannot be talked around by rewriting the
 * SQL, because it does not read the SQL.
 */
export async function scopedQuery<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  scope: UserScope,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  if (!looksScoped(text)) {
    throw new UnscopedQueryError(
      `query is not confined to one user: it neither filters on user_id = $1 nor ` +
        `inserts user_id as its first column from $1:\n${text}`,
    );
  }
  if (params[0] !== scope.user_id) {
    throw new UnscopedQueryError(
      `$1 must be the scope's user_id (${scope.user_id}), got ${JSON.stringify(params[0])}`,
    );
  }

  const result = await db.query<R>(text, params);

  for (const row of result.rows) {
    if (hasUserId(row) && row.user_id !== scope.user_id) {
      throw new CrossUserResultError(scope.user_id, String(row.user_id));
    }
  }

  return result;
}
