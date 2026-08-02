// The user scope, and the guard that makes an unscoped query unwritable.
//
// Two independent mechanisms, because either alone has a hole:
//
//   1. TYPES. `UserScope` is branded, so it cannot be conjured from a bare string and
//      it cannot be defaulted. Every repository method takes it as its first argument,
//      so `npm run typecheck` fails on a call that omits the user.
//
//   2. RUNTIME. `scopedQuery` refuses any SQL that does not filter on `user_id = $1`
//      and any parameter list whose `$1` is not the scope's own user id. Types stop a
//      caller from forgetting; this stops an author from hand-writing a query that
//      reaches across users on purpose or by copy-paste.
//
// Cross-user joins are meant to be arithmetically unavailable (contact_id is HMACed
// per user salt). This layer makes them syntactically unavailable too.

import type { Queryable } from "./pool.js";
import type { QueryResult, QueryResultRow } from "pg";

declare const scopeBrand: unique symbol;

export type UserScope = {
  readonly user_id: string;
  readonly [scopeBrand]: true;
};

const USER_ID_RE = /^usr_[A-Za-z0-9_-]{4,}$/;

export class UnscopedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnscopedQueryError";
  }
}

/** The only way to obtain a `UserScope`. */
export function openUserScope(userId: string): UserScope {
  if (!USER_ID_RE.test(userId)) {
    throw new UnscopedQueryError(`not a user id: ${JSON.stringify(userId)}`);
  }
  return { user_id: userId } as UserScope;
}

/** `user_id = $1` — reads, updates and deletes. Optional table qualifier. */
const SCOPE_PREDICATE_RE = /\b(?:[a-z_]+\.)?user_id\s*=\s*\$1\b/i;

/**
 * Inserts cannot carry a WHERE clause, so the equivalent guarantee is structural:
 * `user_id` must be the FIRST column and `$1` the FIRST value. Both halves are
 * required — a column list starting with `user_id` proves nothing if the values are
 * reordered underneath it.
 */
const INSERT_COLUMNS_RE = /\binsert\s+into\s+[\w".]+\s*\(\s*user_id\b/i;
const INSERT_VALUES_RE = /\bvalues\s*\(\s*\$1\b/i;

function isScopedSql(text: string): boolean {
  if (SCOPE_PREDICATE_RE.test(text)) return true;
  return INSERT_COLUMNS_RE.test(text) && INSERT_VALUES_RE.test(text);
}

/**
 * Run a query that is provably confined to one user.
 *
 * Every read and write in the repository goes through here. The SQL must bind the
 * user to `$1`, and `$1` must be the scope's own user id -- passing a different one
 * is the cross-user query this exists to prevent.
 */
export async function scopedQuery<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  scope: UserScope,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  if (!isScopedSql(text)) {
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
  return db.query<R>(text, params);
}
