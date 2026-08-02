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

**Delete is one operation.** Every table holding derived user data is
`partition by hash (user_id)` and carries
`references users(user_id) on delete cascade`, so
`delete from users where user_id = $1` reaches all of it. `deleteUser` then enumerates
every `user_id`-bearing table from `pg_class` and throws if a single row survived — a
table added later cannot be silently missed.

## Writing a query

Every repository method takes a `UserScope` first, and there is no overload without
one. If you need a new query, use `scopedQuery`; it refuses SQL that neither filters on
`user_id = $1` nor inserts `user_id` as its first column from `$1`.

The only two lookups that begin without a user are in `bootstrapLookups`, and both
return identifiers and nothing else. A third should be a design discussion.
