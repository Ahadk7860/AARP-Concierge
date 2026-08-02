# Track D — Notes

Running log for this track. The user reads this alongside the commit history when
reviewing. Append; do not rewrite history here.

This file is how you talk to the user, since you cannot talk to the other agents.
Everything you want to say to somebody outside this worktree goes here.

## Blockers

Anything that stopped progress. For each: what you were doing, what you expected, what
happened, what you tried, and whether it is still open.

Format: `[prompt NN] <OPEN | RESOLVED> — <what and what you tried>`

`[prompt 01] RESOLVED (2 Aug, by main)` — the foundation added a root
`eslint.config.js` in `548d125`. Re-run after merging: `npm run lint` exited **1**, not
0, on one genuine error in my own code — `'user_salt' is assigned a value but never
used` in `schema.test.ts`. Fixed; `npm run lint && npm run typecheck` now exits 0.
Original entry below, kept for the record.

⚠️ **Correction to my own report.** When I filed this blocker I also wrote "every other
Definition of Done item is green". That was wrong twice over, and both were my errors,
not the foundation's:

- Lint was red, so the checklist was not green with one exception — it was green with
  one **failure**, and describing a failure as an exception is how a red checklist gets
  reported as a pass.
- `npm test -- cloud/api cloud/brief cloud/card cloud/db` names four directories and
  only `cloud/db` exists. It exited 0 because vitest matched the one real path. It
  would have exited 1 on `No test files found` had `cloud/db` also been missing, so
  that criterion was passing for a weaker reason than I claimed. Re-run after merging
  (`vitest run --passWithNoTests` now on main): exits **0**, with 56 tests.

`[prompt 01] SUPERSEDED` — **`npm run lint` cannot pass, and the fix is out of bounds
for this track.** Running the Definition of Done's
`npm run lint && npm run typecheck`, I expected an exit code of 0. `eslint` exits 2
because **no ESLint configuration file exists anywhere in the repository, at any
commit**:

```
$ git show main:eslint.config.js
fatal: path 'eslint.config.js' does not exist in 'main'
$ git show main:.eslintrc.json
fatal: path '.eslintrc.json' does not exist in 'main'
$ npm run lint ; echo $?
ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
2
```

Pre-existing, and it affects all four tracks, not just this one. The fix is a root
`eslint.config.js`. I did not create one: `scripts/check-ownership.sh` classifies it as
**OUT OF BOUNDS** for track D — it is neither under `cloud/(api|brief|card|db)/` nor in
the foundation-owned shared list, which covers `package.json`, lockfiles,
`pyproject.toml`, `.env.example`, `.gitignore`, `README.md`, `scripts/` and `prompts/`,
but not a root config file. Reporting rather than reaching across the boundary.
`npm run typecheck` on its own exits 0, and every other Definition of Done item is
green.

Requested resolution: the foundation adds a root `eslint.config.js`, or the `lint`
script is pointed at a config path a track may own.

## Contract gaps

Anything `prompts/CONTRACTS.md` does not specify, specifies wrongly, or specifies in a
way that does not work in practice. You may not edit it — record it here and report.
Every entry names the prompt where it surfaced.

`[prompt 01] OPEN` — **`brf_` and `dig_` are not in CONTRACTS.md § 6's prefix list.**
§ 6 fixes `usr_`, `dev_`, `h_`, `g_`, `vp_`, `omsg_` and `lmsg_`, and nothing else. But
§ 4 names `digest_id` in the `digest.ingested` payload, so a digest id has to exist and
§ 6 gives it no shape. `brief_id` is worse: nothing in any contract names it — I
invented it outright for the `briefs` primary key, which I should have flagged instead
of quietly minting a prefix.

Both are now **provisional** and hex, matching the house style of the other
server-minted ids (`g_`, `h_`, `vp_` are all hex), and constrained in migration `004`
so the shape is at least consistent and checkable. Neither appears on any wire shape
today.

**If you rule against either prefix, nothing is lost:** `briefs` already has the unique
natural key `(user_id, scheduled_for)` — which is exactly how § 4's `brief.due` event
identifies a brief — and `digests` has `(user_id, generated_at)`. Both tables can drop
the surrogate without a data migration. Needs a ruling before `brief.v1` documents are
stored anywhere durable, i.e. before prompt 05.

`[prompt 01] RESOLVED (2 Aug, by the § 3 correction)` — the user amended § 3: cascade
is the delete mechanism, partitioning is optional, `users` is exempt. My original entry
below reached the same conclusion, and the amendment supersedes it. `users` remains
unpartitioned; the other seven tables stay hash-partitioned because that costs nothing.

`[prompt 01] SUPERSEDED` — **`users` cannot be hash-partitioned as § 3 is written.**
`TRACK.md`
says `user_id` is the partition key "everywhere", and prompt `01` asks that every
user-data table be partitioned. `CONTRACTS.md` § 3 gives the `users` DDL **without** a
`partition by` clause and **with** `phone_e164 text not null unique`. Both cannot hold:
Postgres requires a `UNIQUE` constraint on a partitioned table to include the partition
key, so `unique (phone_e164)` on a table partitioned by `hash (user_id)` is rejected
outright. Partitioning `users` would mean either dropping the phone uniqueness signup
depends on, or moving it to a separate non-partitioned lookup table § 3 does not
describe.

I implemented § 3 verbatim: `users` is the unpartitioned identity root, and all seven
tables holding derived user data are `partition by hash (user_id)`. The property the
partitioning exists for is preserved — **delete is one operation** — because every
child carries `references users(user_id) on delete cascade`, so a single
`delete from users where user_id = $1` reaches every derived row. Hash partitioning
would not have given a per-user partition drop in any case: a hash partition holds many
users, so the cascade was always going to be the mechanism.

No action needed unless the user wants `users` partitioned, which requires amending § 3.

## Shared file changes

Every append to a foundation-owned shared file: dependency manifests, lint config,
`.env.example`. One line each, so the user can anticipate merge conflicts.

Format: `[prompt NN] <file> — added <what> because <why>`

`[prompt 01] package.json` — added `"@types/pg": "^8.11.0"` to `devDependencies`
because `pg` is in the baseline dependencies but ships no type declarations, so
`npm run typecheck` fails with `TS7016` as soon as any file imports it. Appended as the
last entry of the block; nothing reordered, reformatted, or removed.

`[prompt 01] package-lock.json` — regenerated with `npm install --package-lock-only`
(never hand-edited) for the above. 21 inserted lines, no deletions. Expect a conflict
here at merge if another track also appends a dependency.

⚠️ **Warning for the other tracks:** `npm install --save-dev` rewrote the entire
manifest — it alphabetised both dependency blocks and re-encoded the `—` escape in
`description` to a literal `—`. That is a reformat, which the append-only rule forbids,
so I reverted it and hand-edited the single line instead. Any track running
`npm install --save-*` will do the same thing. Check `git diff package.json` afterwards.

## Runtime resources

Any port, database, cache directory, container name, external path, or rate-limited
credential you needed that `CONTRACTS.md` § 9 does not assign to you. Do not pick a
default — another track may pick the same one. Record it and report.

Format: `[prompt NN] needed <resource> — used <what> provisionally / blocked`

`[prompt 01] needed a Postgres server` — **none was installed on this machine.**
Installed `postgresql@16` via Homebrew and started it with `brew services`. This is a
host-level change outside the worktree, so flagging it explicitly. Track D uses the
database name § 9 assigns it (`boi_dev_d`) on the default `:5432` server, which is what
separates it from Track C's `boi_dev_c` — § 9 partitions by database name, not by port,
so sharing the server is the intended arrangement.

`[prompt 01] needed nothing else` — `.env` was copied from `.env.example` and its
Track D values (`API_PORT=3041`, `CARD_PORT=3042`,
`DATABASE_URL=postgres://localhost:5432/boi_dev_d`) were already correct and left
unedited. Ports 3041/3042 are not bound by anything in this prompt. `/tmp/boi-d` was
created and is unused so far.

## Requests to other tracks

Things another track owns that you need. You cannot reach across and do it yourself.
Record it, report it, and continue with a local workaround only if the workaround is
visible and reversible.

Format: `[prompt NN] → Track <X>: <what you need and why>`

None. Nothing in this prompt required another track's code, per `CONTRACTS.md` § 10.

## Deviations from the plan

Anywhere the implementation departs from what the prompt described, and why. A
deviation is not a failure — an unrecorded one is.

### Corrections to prompt 01, applied 2 Aug after review

`[prompt 01] FIXED — severe, and it was mine.` **Generated ids violated the frozen
schemas about a third of the time.** `ids.ts` built `usr_` and `dev_` ids with
`randomBytes(9).toString("base64url")`, whose alphabet includes `-` and `_`.
`contracts/schema/digest.v1.json` requires `^usr_[0-9a-zA-Z]{8,32}$` and
`^dev_[0-9a-zA-Z]{8,32}$`. Roughly one id in three carried a character the wire
contract rejects.

Nothing local caught it because every local check was written with the same wrong
assumption: the SQL `CHECK`s and the scope regex both used `[A-Za-z0-9_-]`, and no
stored payload is validated against its schema anywhere in this track. It would have
surfaced at integration with Track A as an intermittent one-in-three failure — the
worst possible shape for a bug, because it reads as flakiness rather than as a defect.

Fixed in three places, so no single one of them has to be right on its own:

1. `ids.ts` uses base62 (rejection-sampled, not `% 62`) for `usr_`/`dev_`/`omsg_`, and
   hex for `dig_`/`brf_`.
2. Migration `004_tighten_id_constraints.sql` makes every SQL `CHECK` match the frozen
   pattern exactly, including the upper bounds the originals omitted. Written as a new
   migration rather than an edit to 001-003, because those have been applied and the
   runner rejects a changed checksum on purpose.
3. `scope.test.ts` reads the patterns **out of `contracts/schema/*.json` at run time**
   and generates 1,000 of each. It follows the frozen contract rather than a copy of
   it, so a future drift in either direction fails here instead of at integration.
   Plus a check that all 62 alphabet characters are reachable, since a modulo-biased
   generator would still satisfy the pattern.

`[prompt 01] FIXED — I overclaimed what the scope guard delivers.** `scopedQuery`'s SQL
check is a substring regex and it does not hold. All of these satisfied it and returned
other users' rows:

```sql
select b.user_id from relationships a join relationships b
  on a.display = b.display where a.user_id = $1
select user_id, display from relationships -- user_id = $1
select user_id from relationships where user_id = $1 or true
```

What changed:

- **Comment stripping**, which kills the third bypass outright.
- **Result verification** — every returned row whose `user_id` is not the scope's now
  throws `CrossUserResultError`. This is the half that actually holds, because it
  inspects what came back rather than what was asked, and it cannot be talked around by
  rewriting the SQL. It catches the self-join and the `or true`.
- **The claim in `cloud/db/README.md` is now a table** stating each mechanism's real
  strength, with the SQL regex marked *weak — a typo catch, not a boundary*.
- **The remaining hole is a passing test.** `select b.display ... where a.user_id = $1`
  still leaks, because the result check has no `user_id` column to inspect.
  `scopeLeakRegressions` in `scope.test.ts` asserts the leak, against real Postgres in
  `schema.test.ts`, so it is documented in executable form and any future fix breaks
  the test and forces the README to be updated with it. Closing it properly needs SQL
  parsing or Postgres RLS under a non-superuser role — neither is in this prompt.

`[prompt 01] FIXED — the IDOR the branded type does not prevent.** A `UserScope` proves
you named *a* user, never that you named the *authorized* user, and the constructor was
exported as the innocuous-sounding `openUserScope`. A prompt-02 handler writing
`openUserScope(req.params.user_id)` would have had a full IDOR on
`DELETE /v1/users/{id}` that typechecks cleanly.

Renamed to **`unsafeScopeFromUserId`**, with the IDOR spelled out at the definition, in
the README, and here. The name is the fix: every call site now reads as a place to
stop. The safe sources are `createUser` and the two `bootstrapLookups`.

**Carried into prompt 02 as a hard requirement:** every endpoint taking a `user_id` in
its path or body must compare it against the scope derived from the device token and
return `401 {"error":"unauthorized"}` on mismatch. The database layer cannot do this.

`[prompt 01] FIXED — the delete test restated production code.** `deleteUser` runs
`residueByTable` itself and throws `ResidualUserDataError` first, so the test's
zero-row assertion could never fail independently. And its last line compared
`verified_tables` to a hard-coded list — the exact hard-coding the prompt forbade,
reintroduced at the end.

Now four tests that can each fail on their own:

- The zero-row proof issues the **bare `delete from users where user_id = $1`** and
  checks the catalog itself, so it tests the cascade rather than the guard.
- A separate test proves the guard is **live rather than decorative**, by giving
  `deleteUser` a table that references `users` without cascading.
- A test proves the enumeration **refuses to verify what it cannot count**.
- Every assertion compares against the live enumeration. The literal table list is used
  only by a schema-completeness test, which is a different question.

`[prompt 01]` — **Unique constraints on partitioned tables are declared unnamed.** A
`UNIQUE` constraint on a partitioned table is enforced by a per-partition index, and a
violation reports *that index's* name (`digests_p3_user_id_generated_at_key`), never a
name declared on the parent. I removed the custom names rather than keep documentation
that never appears in the error it documents; `isUniqueViolation` in `repository.ts`
matches the column-derived suffix instead. `CHECK` constraints do report their declared
names, and keep them.

`[prompt 01]` — **Migrations run from a `tsc` build, not
`node --experimental-strip-types`.** `TRACK.md` gives the run command as
`node --experimental-strip-types cloud/api/src/server.ts`. That does not work with the
foundation's own import convention: `cloud/shared/src/index.ts` imports
`./contracts.js`, which is what TypeScript's `NodeNext` resolution requires, but Node's
type-stripping resolves specifiers literally and looks for a `.js` file that does not
exist:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../cloud/db/src/pool.js'
  imported from .../cloud/db/src/migrate.ts
```

I did not change `tsconfig.json` — it is shared, and the permissive options that would
fix this (`allowImportingTsExtensions`) conflict with its existing
`declaration: true` + `outDir`. `cloud/db` builds with the project's own `tsc` and runs
from `dist/`; see `cloud/db/README.md`. Vitest is unaffected because it resolves `.js`
to `.ts` itself, which is why the whole test suite runs from source.

Flagging because prompt `02` runs an HTTP server and will hit exactly this wall — and
so will Track C.

## Decisions made

Choices the prompt left open that you had to resolve: a library, a data structure, an
error-handling approach. The user needs to see these before merge, because another
track may have chosen differently.

`[prompt 01] 2 Aug` — **The delete enumeration walks foreign keys; it does not look for
a column named `user_id`.** § 3's correction asks this to be decided now rather than at
prompt 04, and offers two options: give every table a `user_id`, or walk foreign keys
from `users`.

**Chose the foreign-key walk**, because the other option is a convention and this one
is a fact. "Every table carries `user_id`" holds only until somebody adds a
`brief_items` table and nothing tells them they broke the delete guarantee — the
enumeration would keep returning a clean zero for a table it never looked at, which is
the failure mode dressed as a pass.

`deletionReachableTables` walks `pg_constraint` transitively from `users`.
`residueByTable` uses it and raises `UncountableTableError` if it finds a reachable
table with no `user_id` column, naming the table and refusing to report. A test creates
exactly that shape and asserts the refusal. A second test asserts every reachable table
is reached through `on delete cascade` — a non-cascading edge would block or orphan.

Both enumerations are kept, and a test asserts they **agree**. They do today. The
moment they disagree, a table exists that one of them cannot see, and that is the
moment to find out rather than at the first CCPA request.

Still open, and not in this prompt: § 3 also counts derived data **outside** Postgres.
A rendered card at `briefs.card_url` is derived data and nothing here reaches it.
Prompt 04 owns that, and it needs a real answer, not a note.

`[prompt 01]` — **The device token carries its user id: `<user_id>.<secret>`.** The
alternative, an opaque token, forces authentication to search for a row without knowing
the user — a global secondary index across every partition, and the one unscoped read
path that would undermine the whole repository layer. Carrying the id makes
authentication a single-partition, fully scoped read. The id half is not a secret and
is not what authenticates; only the SHA-256 of the whole token is stored, compared in
constant time.

`[prompt 01]` — **Pairing-code uniqueness is a transactional advisory lock, not a
constraint.** Six digits typed by a human cannot carry a user id, so resolving a code
is the one lookup that legitimately begins without one. A `UNIQUE` constraint cannot
help: on a table partitioned by `user_id` it would have to include `user_id`, which
guarantees nothing about a code typed by a stranger. `issuePairingCode` takes
`pg_advisory_xact_lock(hashtext('pairing_code:' || code))` and then probes, which is
real mutual exclusion rather than check-then-hope.

`[prompt 01]` — **Exactly two unscoped lookups exist, and they are named as such.**
`bootstrapLookups.resolvePairingCode` and `bootstrapLookups.authenticateDeviceToken`.
Both return identifiers only — never a display name, never a payload. Everything that
reads user content goes through `UserScope`. Adding a third should be treated as a
design change, not a convenience.

`[prompt 01]` — **The scope guard is enforced twice, by types and at runtime.**
`UserScope` is branded, so it cannot be conjured from a string or defaulted, and
`npm run typecheck` fails on any repository call that omits it. `scopedQuery`
independently refuses SQL that neither filters on `user_id = $1` nor inserts `user_id`
as its first column from `$1`. Types stop a caller from forgetting; the runtime guard
stops an author from hand-writing a cross-user query on purpose or by copy-paste.

`[prompt 01]` — **`deleteUser` verifies its own completeness in production, not only in
a test.** After the cascade it enumerates every `user_id`-bearing table from `pg_class`
and throws `ResidualUserDataError` if anything survived. A table added next month that
somehow escapes the cascade fails the request loudly instead of leaving user data
behind quietly. Deletes are rare, so the catalog scan costs nothing that matters.

`[prompt 01]` — **8 hash partitions per table.** Arbitrary but not free to change
later; recorded so a future prompt does not pick a different number and split the
schema.

## Observations

Anything you noticed that the plan did not anticipate, including work that should exist
but is not in any track's scope. This is often the most useful section at review time.

`[prompt 01]` — **The `is_from_me = 1` guard has no home yet.** `CONTRACTS.md` § 7 names
three independent places it must be asserted; the second is "the upload boundary —
`POST /v1/voice-pack` returns `422 redaction_failed` and stores nothing (Track D)".
That is prompt `02`, and nothing in this prompt can enforce it: the repository has no
partial-write path and assumes validation already passed. Noting it so it cannot be
lost between prompts. The third guard, `scripts/check_voice_pack_leak.py`, is run by
Tracks A and B — nothing in track D's test commands invokes it.

`[prompt 01]` — **`@boi/shared` is a `tsconfig` path alias with no runtime resolution.**
`tsc` does not rewrite it on emit, so `import { X } from "@boi/shared"` compiles but
fails at runtime from `dist/`. It works here only because every one of my imports from
it is `import type`, which is erased. Prompt `02` will need real values from it (the
`Channel` interface is a type, but `StubChannel` is a class) and will need a resolution
strategy — an `imports` map in `package.json`, or a relative path. Related to the
`--experimental-strip-types` deviation above; both are the same missing piece.

`[prompt 01]` — **Nothing validates a stored payload against its JSON Schema.** The
`jsonb` columns are constrained by SQL `CHECK`s on the scalar columns beside them, but
the payloads themselves are trusted. `scripts/validate_fixtures.py` exists and is
language-neutral, but it is a Python script over files on disk, not something the
TypeScript ingest path can call per request. Prompt `02` will presumably do this with
`zod`, which is already in the baseline manifest; flagging that the two definitions of
each shape (JSON Schema and zod) can then drift, with `contracts/schema/*.json` being
the stated arbiter.

`[prompt 01]` — **`vitest` runs test *files* in parallel.** All the database tests are
in one file on purpose, because they drop and rebuild the schema. A future prompt that
adds a second database-touching test file will get two workers rebuilding one database
at once, and the failures will read as flaky tests rather than as the collision they
are. `vitest.config.ts` is shared and I did not touch it; the constraint is documented
at the top of `cloud/db/src/schema.test.ts` instead.
