# `cloud/db` — schema, migrations, repository

Track D owns this. `CONTRACTS.md` § 3 is the source for the schema; this README covers
only how to run it.

## Setup, once per worktree

Worktrees share neither untracked files nor installed dependencies.

```bash
npm install
cp .env.example .env          # Track D's values are already correct
createdb boi_dev_d            # CONTRACTS.md § 9 — never a shared `boi_dev`
```

## Migrating

The migrations are `.sql` files read from the source tree, so it does not matter
whether the runner was loaded from `cloud/db/src` or from `dist/`.

```bash
npx tsc -p tsconfig.json && node --env-file=.env dist/cloud/db/src/migrate.js
```

`node --experimental-strip-types cloud/db/src/migrate.ts` does **not** work: the
project's `NodeNext` resolution requires `.js` import specifiers, and Node's
type-stripping resolves them literally. See `## Deviations from the plan` in
`prompts/track-d-cloud-surface/NOTES.md`.

Running twice is a no-op — migrations are recorded in `schema_migrations` by version
and checksum, and every statement is independently `if not exists`. Editing a migration
that has already been applied is an error, not a silent re-apply: migrations are
forward-only, so add a new one.

## Testing

```bash
npm test -- cloud/api cloud/brief cloud/card cloud/db
```

The suite drops and rebuilds the schema in `boi_dev_d` before it runs, so it proves
"clean from empty" rather than asserting it.

## The two properties that cannot be retrofitted

**Per-user salted contact ids.** `contact_id = HMAC(user_salt, normalized_handle)`,
computed on the Mac. The same phone number produces a different id for every user, so
cross-user joins are arithmetically unavailable — not forbidden by policy but
unavailable to a rogue query or a subpoena. The server never sees a raw handle for
anyone but the account holder.

**Delete is one operation.** Every table holding derived user data carries
`references users(user_id) on delete cascade`, so
`delete from users where user_id = $1` reaches all of it. **Cascade is the mechanism,
not partitioning** — CONTRACTS.md § 3's correction of 2 Aug. A hash partition holds
many users, so there was never a per-user partition to drop. Partitioning is kept where
it costs nothing; `users` is exempt.

`deleteUser` then enumerates every table **reachable from `users` by foreign key** and
throws if a single row survived. The walk is deliberately not a search for columns
named `user_id`: § 3 warns that prompts 04-05 add `brief_items`-shaped tables keyed on
a parent id, which a column-name query cannot see. If the walk finds a reachable table
it cannot count, it raises `UncountableTableError` rather than reporting a clean zero
for a table it never looked at.

Still open: § 3 also says derived data **outside** Postgres counts. A rendered card at
`briefs.card_url` is derived data, and nothing here reaches it yet. That belongs to
prompt 04.

## Writing a query

Every repository method takes a `UserScope` first, and there is no overload without
one. If you need a new query, use `scopedQuery`.

### What the scope layer guarantees, precisely

An overstated security claim is worse than none, because it stops people looking for
the real control. So, exactly:

| Mechanism | Strength | Catches |
|---|---|---|
| Branded `UserScope` type | **strong** | forgetting to scope a query — `npm run typecheck` fails |
| Result verification | **strong, partial** | any returned row whose `user_id` is not the scope's |
| SQL text regex | **weak** | typos and copy-paste. Not a boundary. Defeatable by construction. |

**The hole that remains.** A query can return another user's data in columns other than
`user_id`. This leaks display names past every guard here:

```sql
select b.display from relationships a
  join relationships b on a.display = b.display
 where a.user_id = $1
```

Closing it needs SQL parsing, or Postgres row-level security under a non-superuser
role. `scopeLeakRegressions` in `scope.test.ts` pins the known bypasses — including
this one, as a passing test asserting the leak — so the boundary is documented in
executable form rather than in prose that drifts.

### A scope is not authorization

`unsafeScopeFromUserId` validates the *shape* of an id, nothing more. A scope proves
you named **a** user, never that you named the **authorized** user. Building one from a
request path is an IDOR, and it typechecks:

```ts
// WRONG — deletes whoever the caller names.
await deleteUser(unsafeScopeFromUserId(req.params.user_id));

// RIGHT — the scope comes from the credential, and the path must match it.
const auth = await bootstrapLookups.authenticateDeviceToken(token);
if (auth === null || auth.scope.user_id !== req.params.user_id) return unauthorized();
await deleteUser(auth.scope);
```

`DELETE /v1/users/{id}` is the endpoint where getting this wrong is unrecoverable.
The HTTP layer owns this check; the database layer cannot make it for you.

The safe sources of a scope are `createUser` and the two `bootstrapLookups`, both of
which return identifiers only. A third bootstrap lookup should be a design discussion.
