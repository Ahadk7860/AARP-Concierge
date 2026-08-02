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

`[prompt 06] OPEN — THREE CONTRACT CHANGES I WAS TOLD ABOUT BUT CANNOT SEE.**
I was asked to pull main for three changes affecting this prompt. `git merge main` is a
genuine no-op: `main` is `618d81a`, `origin/main` matches it, and none of the three is
present. They are on **`track-c-transport`**, in `206dee1`:

```
$ git branch --contains 206dee1
  track-c-transport          <- not main
$ git show main:contracts/fixtures/brief/stale_warning.json | grep hours_stale
    "hours_stale": 98.8,     <- still the inconsistent value
$ grep reply_to_message_id contracts/fixtures/inbound/draft_choice_2.json
  "reply_to_message_id": "omsg_9001",   <- not lmsg_01J8ZK
```

MERGE-POLICY forbids merging a sibling branch and TRACK.md forbids reading another
track's worktree, so I did neither. What I did instead, per change:

1. **The `omsg_` -> provider-id mapping is built and is prefix-agnostic.** It keys on
   `messages_out.provider_message_id`, matched and never parsed, so it resolves
   `omsg_9001` today and `lmsg_01J8ZK` unchanged when the fixture lands. There is a test
   that drives it with a deliberately alien id (`xyz~weird~2`) to prove no prefix
   assumption exists anywhere in the path. **Nothing needs to change when the fixture
   updates.**
2. **The staleness invariant test is kept, unchanged.** It asserts `hours_stale` always
   equals the difference between the two timestamps emitted — which is the property the
   current fixture violates and the fixed one will satisfy. It will pass either way.
3. **The raw-body parser and header guard are implemented** (below).

Nothing here is blocked. Flagging because a contract amendment that lives on a track
branch reaches no other track — WORKTREE-PROTOCOL's amendment sequence is
amend -> commit to base -> each track merges base forward, and step two has not happened.

`[prompt 06] RESOLVED (2 Aug, by main `02a815e`)` — **`Channel.normalizeInbound` is now
typed `Buffer | string` and `StubChannel` enforces it.** The foundation retyped the seam
and made the stub throw `raw_body_required` on a parsed object, parse real bytes
otherwise. The gap was real and it was at the interface, not in either implementation:
`unknown` let two implementations of one frozen method disagree about what their first
argument meant.

Now wired against the stub, as asked — `webhook.test.ts` drives `normalizeInbound`
through `StubChannel` with an actual `Buffer`, asserts a Buffer and the equivalent
string produce identical messages, asserts the parsed-object case throws, and drives the
whole route with a Buffer body end to end.

I kept the local HMAC double alongside it. The stub accepts any body with a fixed
signature string, so it cannot show the bytes reached the verifier UNCHANGED; only a
real HMAC over deliberately awkward whitespace and key order does that. Verified both
halves bite by regressing the route to pass `req.body`: two tests fail, one from each.

`[prompt 06] SUPERSEDED` — **`StubChannel.normalizeInbound` cannot exercise the raw-body
path.** Track C's adapter requires the raw request bytes and throws
`RawBodyRequiredError` on a parsed object. The foundation's stub does the opposite: it
does `rawBody as Record<string, unknown>` and reads `.id` off it, so handing it raw
bytes yields a message with every field defaulted. `cloud/shared/**` is frozen.

The two stubs therefore disagree about what the first argument of a frozen interface
means, and a track developing against the stub will write a webhook that breaks the
moment the real adapter lands — which is exactly what happened to Track C's warning to
me. I wired the route for the REAL contract (raw bytes) and tested it against a local
double that behaves as Track C describes, with an explicit test that the double rejects
a parsed object. `StubChannel` remains used everywhere else.

Worth resolving in the foundation: either the stub should accept raw bytes too, or
`Channel.normalizeInbound`'s first parameter should be typed `string | Buffer` rather
than `unknown` so the requirement is visible in the type.

`[prompt 03] OPEN` — **Signup has no documented endpoint.**
`contracts/openapi/boi-api.v1.yaml` documents `POST /v1/pair` and nothing that creates
the account the code belongs to. Prompt 03 requires signup — phone, email, terms — and
a confirmation page, so I implemented `GET /signup` and `POST /signup`, and they are
**undocumented surface**. Probably deliberate, since it is a web page rather than
something the Mac calls, but Track C will eventually need to know that an account can
exist before any device has paired.

The shapes, for the record: `POST /signup` takes
`{phone_e164, email?, accept_terms: true, timezone?}` as JSON or urlencoded and returns
`200 text/html`, or `400 {"error":"validation","detail":...}`. It is idempotent on
`phone_e164`, which is the join key.

`[prompt 03] OPEN` — **`/v1/pair` documents no `400`, so a malformed body returns
`404 invalid_code`.** The document gives that endpoint exactly `200` and
`404 {"error":"invalid_code"}`. A body with a missing `device_id` or a five-digit code
is a validation failure, and inventing a `400` would be a shape Track A has not been
told about. Collapsing it into the documented `404` also stops the endpoint being an
oracle that distinguishes "malformed" from "wrong". Flagging because it is a real
deviation from how every other endpoint in this API reports a bad body.

`[prompt 05] OPEN` — **`contracts/fixtures/brief/stale_warning.json` disagrees with
itself.** Its `hours_stale` is `98.8`, but its own two timestamps are 122.8 hours apart:

```
digest_as_of  2026-07-28T09:14:00Z   (a Tuesday)
scheduled_for 2026-08-02T12:00:00Z
difference    122.8 hours, not 98.8
```

98.8 hours before that `scheduled_for` is Wednesday the 29th, while the fixture's
message says *Tuesday* — so the message agrees with `digest_as_of` and `hours_stale`
agrees with neither. `contracts/**` is frozen, so I could not fix it.

The Definition of Done says a 98-hour digest must warn "matching
`stale_warning.json`'s shape", and shape is what I matched: same keys, same types, same
sentence. `hours_stale` I compute from the timestamps, and there is a test asserting the
invariant the fixture violates — the number emitted always equals the difference between
the two timestamps emitted, across six spans. Asserting the fixture's `98.8` would have
meant hard-coding a value that contradicts its own inputs.

Likely fix: `digest_as_of` should be `2026-07-29T09:12:00Z` and the message *Wednesday*,
or `hours_stale` should be `122.8`. Track A and Track B may both read this fixture.

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

`[prompt 05] .env.example` — appended `BOI_STALENESS_SKIP_HOURS=168` because prompt 05
requires a hard threshold beyond which the morning send is skipped entirely, and the
file had only `BOI_STALENESS_WARN_HOURS`. 168 hours is a week; it has to sit above the
98-hour case the checklist requires to still WARN rather than skip. One appended line at
the end of the Track D block; nothing reordered.

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

`[prompt 06] FIXED — and it was the exact failure the review predicted.**
`deliverBrief` returned the `OutboundMessage`s but discarded the `SendResult`s, so
`provider_message_id` was never written and every threaded reply resolved to
`ambiguous`. Four tests caught it. `SendResult.message_id` really is the only place that
link exists, and I had dropped it on the floor between prompt 05 and prompt 06.

`DeliveryResult` now carries `delivered: SentMessage[]` — message, `SendResult`, and the
item index — and `run.ts` writes both halves into the same row. Migration `007` adds
`messages_out.item_index`, without a CHECK on the id's prefix: the value comes from
whichever transport sent it, and constraining it would break either the stub or Linq.

`[prompt 06]` — **The webhook route wires both of Track C's warnings.** A raw-body
content-type parser registered before anything else touches `application/json`, keeping
the bytes on `req.rawBody` while still returning a parsed object so no other route
changes. A test signs a body with deliberately awkward whitespace and key order, which
would fail if the route re-serialised. And `signatureHeader` collapses
`string | string[] | undefined` to `string | null`, treating a duplicated header as a
refusal rather than taking `[0]` — two headers is an attack shape, not a mistake.

`[prompt 06] RATIFIED (2 Aug, CONTRACTS § 2)` — **`/v1/webhooks/{provider}` in
`cloud/api/`.** Recorded as a deviation; § 2 now states it explicitly, on the grounds
that it belongs with the other HTTP routes and the signature guard has to sit beside the
auth middleware rather than in the composer. A documented deviation from prompt 06's
paths, not an ownership violation. `check-ownership.sh d` is clean.

`[prompt 06]` — **An unthreaded reply to a multi-item brief asks instead of guessing.**
The checklist says a bare `2` attributes to the most recent brief, and it does. But a
brief with three people and no thread cannot resolve to an ITEM, and picking the first
would be a guess — the same prohibition the checklist applies to a reply matching no
brief. One item resolves; more than one asks which person.

`[prompt 05]` — **Threading sends N+1 messages; unthreaded sends exactly one.** The
prompt says "per-item threading when `capabilities()` reports it", and `outbound.v1` is
one message with blocks — so per-item threading has to mean one message per item,
each `reply_to_message_id`-linked to a lead. Without threading everything collapses into
the lead's block list, silently: no capability request, and nothing in the copy mentions
it. A transport that cannot thread is not an error condition.

`[prompt 05]` — **An empty morning sends nothing.** Not in the checklist, and not
strictly required. Sending "0 people worth a message today" every quiet day is how a
habit becomes a notification people switch off, so `deliverBrief` returns
`nothing_to_say` and the channel stays untouched. Prompt 06 may want to revisit this if
the scheduler needs a heartbeat the user can see.

`[prompt 05]` — **`BOI_BRIEF_MAX_ITEMS` can lower the cap but never raise it.**
`brief.v1.json` sets `maxItems: 3`. An env var able to exceed that would produce
documents the validator rejects at the moment somebody sets it to 20 in production, so
`maxItems()` takes the minimum of the configured value and 3. Asserted.

`[prompt 04]` — **Two layout breaks found by looking at the images, not by the tests.**
The first render clipped the caption — `"…went quiet this yea"` with the `r` past the
right edge — because SVG does not wrap and resvg exposes no text-measurement API. The
second, after adding a wrapper, drew a 40-character name straight through
`one-way enthusiasm`: `MAX_NAME_CHARS` bounds a name to 18 characters, but the row also
holds a bold label, and `"the one you keep waiting"` is 24. The third attempt still
overlapped by two letters, because the width estimate used the regular-weight constant
for a bold label.

Now: `wrapByWidth` for the caption, a per-row width budget computed from what the label
leaves, and a weight-aware `estimateWidth` (0.52em regular, 0.60em bold). Two tests
assert no row exceeds the content width for four name shapes, and that every wrapped
line fits inside the margins.

Worth saying plainly: **the tests passed through all three of those renders.** A PNG is
1080×1920 whether or not the text inside it is legible, and dimension and determinism
assertions cannot see a collision. The images in the report are the evidence here, not
the green checklist.

`[prompt 04]` — **The `grep -rin 'reciproc' cloud/card/` criterion needed the term not
to appear even in a test asserting its absence.** My first version of the copy test
spelled it, which made the grep return matches for the most benign possible reason. I
did not weaken the test: it now reads the banned term OUT OF `CONTRACTS.md` § 6
(`**Don't ship X.**`) at run time and scans both the copy strings and every non-test
source file in `cloud/card/src` for its stem. That is strictly stronger than the literal
check — it follows the contract if § 6's list grows — and it leaves the grep meaningful.
Verified it bites by planting `RECIPROCITY_SCORE` in `copy.ts`: the test failed.

`[prompt 03]` — **Migration `006_handle_status.sql` is in `cloud/db/`, same deviation as
005.** Prompt 03 lists `cloud/api/` as its path scope and requires handle-mismatch
detection to be recorded rather than passing silently. Whether a user is reachable on
iMessage is a property of the ACCOUNT, not of any one message, so it is a column on
`users` rather than something re-derived from `messages_out.protocol` at read time.
`cloud/db/**` is this track's per `TRACK.md`; `check-ownership.sh d` is clean.

`[prompt 03]` — **The pairing clock is a parameter, not `now()` in SQL.** The Definition
of Done says to test expiry "by controlling the clock, not by sleeping", and the
original prompt-01 implementation compared against the database's `now()`, which a test
cannot move. `issuePairingCode`, `consumePairingCode` and
`bootstrapLookups.resolvePairingCode` now take the instant explicitly, defaulting to
`new Date()`. The expiry test issues at T, checks `T + 599s` still pairs, and
`T + 601s` does not — the boundary from both sides, in milliseconds.

`[prompt 02]` — **Migration `005_heartbeat_fields.sql` is in `cloud/db/`, which prompt
02 lists as out of its path scope.** The prompt says "Paths you may modify:
`cloud/api/`", and also requires `POST /v1/heartbeat` to record `digest_as_of` "so
staleness is computable". `devices` had only `last_heartbeat_at` after prompt 01, which
answers "is the Mac awake" and not "how old is the newest fact we hold" — and prompt 05
needs the second. There is no way to satisfy the criterion without a column.

`cloud/db/**` is owned by this track per `TRACK.md`, so this is inside the track and
outside the prompt. `check-ownership.sh d` is clean. Flagging rather than silently
widening the prompt's scope.

`[prompt 02]` — **Oversized voice packs return `400`, not `422`.** The checklist says a
pack with more than 40 exemplars or an exemplar over 200 characters "is rejected"
without naming a code. `maxItems: 40` and `maxLength: 200` are `voice_pack.v1.json`
constraints, so they are schema violations, and the OpenAPI document reserves `422`
specifically for the redaction assertions (`error: {const: redaction_failed}`).
Returning 422 for a size violation would make the code meaningless. Both are asserted
as 400, and both also assert nothing was stored.

`[prompt 02]` — **The two database test files are serialised with a Postgres advisory
lock, not a vitest setting.** Adding a second database-touching file created exactly
the collision I predicted in prompt 01's observations: `schema.test.ts` drops and
rebuilds the schema in `beforeAll` while `ingest.test.ts` inserts into it, and the
first combined run failed 41 tests with errors that read as flakiness.

The natural fix is `--no-file-parallelism` or a `poolOptions` entry in
`vitest.config.ts`. That file is foundation-owned, and the setting is global — it would
serialise Track C's suite too, in a worktree I cannot see, and slow it down for a
problem it does not have. So `cloud/db/src/test-lock.ts` takes a session-level advisory
lock that binds exactly the two files that need it. If the foundation would rather have
the config setting, it is a two-line change and I will drop the lock.

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

### Corrections to prompt 02, applied 2 Aug after review

`[prompt 03] FIXED.` **`@boi/shared` finally broke, exactly where prompt 01 predicted.**
That prompt's observations said the alias is a `tsconfig` path with no runtime
resolution, that my code only worked because every import from it was `import type`
(erased at emit), and that the first prompt needing a real VALUE would hit it. Prompt 03
needs `StubChannel`, which is a class, and vitest failed with
`Failed to load url @boi/shared`.

Fixed by replacing every `@boi/shared` specifier in `cloud/api/**` and `cloud/db/**`
with a relative path to `cloud/shared/src/index.js` — ten files, imports only, no change
to `cloud/shared` itself. The alternative was a `resolve.alias` entry in
`vitest.config.ts`, which is foundation-owned and would change module resolution for
Track C in a worktree I cannot see. Relative paths need no shared-file change and work
under `tsc`, vitest and plain `node` alike.

`tsconfig.json`'s `paths` entry for `@boi/shared` is now unused by this track. I left it
alone — it is shared, and Track C may be relying on it.

`[prompt 02] FIXED — severe.` **The 422 guard scanned one of four free-text fields.**
`findRedactionViolations` took `pack.exemplars`; `upsertVoicePack` stores
`JSON.stringify(pack)` — the whole document. `register.apology_openers` holds verbatim
message prefixes (the fixture's are `"sorry been mia"` and `"omg sorry"`), so this was
accepted with a 202 and persisted:

```json
"exemplars": ["ok that works for me"],
"register": { "apology_openers": ["sorry i still owe you $40, call me on 415-555-0142"] }
```

All three of my phone/email/amount tests stayed green, because **per-pattern coverage
cannot see a missed field.** The tests are now per-FIELD as well: `exemplars`,
`register.apology_openers`, `register.abbreviations`, `register.top_emoji`, each with
the payload above, at both the unit and the endpoint level, each asserting zero rows
after the rejection. Plus a test that derives the list of free-text arrays from
`voice_pack.v1.json` itself, so a new free-text field in the contract fails until it is
scanned. Live check after the fix: `422`, `voice_packs` row count `0`.

`[prompt 02] FIXED — severe.` **The zod mirror disagreed with the frozen schema in both
directions.** Too strict: `archetype`, `first_contact_at`, `last_contact_at` and the two
`corpus` timestamps were `.nullable()` but not `.optional()`, and none is in the frozen
`required` list — Track A would have received a `400` for a document
`validate_fixtures.py` calls valid. `days_since_last_contact` and `span_days` were
`z.number()` where the schema says `integer`; `health_reasons` was `z.array(z.string())`
where it is an enum; `display` had no length bounds. Too loose: `whole_life` used
`.passthrough()` under a comment claiming the frozen schema allows extra keys — it sets
`additionalProperties: false`.

Neither direction was visible against the fixtures, because every committed fixture is
fully populated and none carries a junk key.

Fixed field by field, and then made mechanically un-driftable:
`cloud/api/src/differential.test.ts` runs the zod mirror and **ajv over the frozen JSON
Schema** against ~50 boundary documents — every fixture, a minimal digest, each optional
field individually removed, a junk key at each nesting level, and type probes — and
fails on any disagreement in either direction. CONTRACTS.md § 1 makes the JSON Schema
the arbiter, so ajv is the reference and zod is the thing under test.

I verified it bites rather than assuming it does. Reintroducing the archetype defect:
`digest relationship without archetype: frozen schema says VALID, zod says invalid`.
Reintroducing the passthrough defect:
`digest junk key in whole_life: frozen schema says invalid, zod says VALID`. There is
also a permanent test asserting the differential itself is not vacuous.

`POST /v1/digest` now has a minimal-digest round-trip — only the frozen schema's
required fields, at every level — with a companion assertion that removing any remaining
key makes it invalid, so "minimal" cannot quietly stop being minimal.

`[prompt 02] FIXED.` **`userIdFromDeviceToken` was the last survivor of the base64url
defect, and it turned a garbage token into a 500.** It matched
`^usr_[A-Za-z0-9_-]{4,}$` — the loose alphabet — so `usr_has-dash_here.secret` parsed as
a well-formed user id and `unsafeScopeFromUserId` then *threw* on it. The route returned
500 where the answer is 401. None of the existing per-route 401 tests caught it because
none of their tokens contained a dot.

Now the frozen `^usr_[0-9a-zA-Z]{8,32}$`, with a test asserting the parser and the scope
constructor accept exactly the same set over 1,000 real tokens, and an endpoint test for
four malformed prefixes. Live: all return 401.

**On the 1,000-id test:** it was already there from the previous round, at
`scope.test.ts` "generated ids satisfy the frozen JSON Schemas", reading the patterns out
of `contracts/schema/*.json` and generating 1,000 each of `usr_`, `dev_` and `h_`. The
review pointed at `scope.test.ts:134`, which is a `returning()` test helper. But the
pointer was in the right neighbourhood — `ids.ts` genuinely still held a loose regex, and
that is the fix above.

`[prompt 02] ALREADY DONE — the two "note rather than fix" items.` Both landed in
`27849f0`, the previous correction commit, so no change was needed:

- `scope.ts`'s header no longer says "syntactically unavailable". It has said
  `3. SQL TEXT CHECK — WEAK. A regex, and it is defeatable by construction. It exists to
  catch typos and copy-paste, not attackers` since that commit, and it names all three
  bypasses. `grep -rn "syntactically" cloud/` returns nothing. NOTES already says the
  SQL guard is a lint rather than a boundary, under `## Deviations`.
- `residueByTable` already walks foreign keys — `deletionReachableTables` recurses over
  `pg_constraint` from `users`, and the comment at `ingest.ts` is accurate. The
  `attname = 'user_id'` matches remaining in `catalog.ts` are the `has_user_id` probe
  that *raises* `UncountableTableError` for a `brief_items`-shaped table, plus
  `userScopedTables`, which is kept only as a cross-check that the two enumerations
  agree. The decision was recorded under `## Decisions made` in the same commit.

`[prompt 02]` — **Third-party full names are NOT asserted by the upload guard.**
CONTRACTS.md § 7 lists five things the Mac redacts: phone numbers, email addresses,
street addresses, dollar amounts, and third-party full names. The server guard asserts
the first four. It does not assert the fifth, and this is a deliberate choice I want
overruled if you disagree.

A server-side full-name assertion means "two consecutive capitalised words". That
rejects "Union Square", "Blue Bottle", "New Year", "Whole Foods" — legitimate redacted
exemplars, rejected permanently, with no edit the Mac can make to comply. Over-rejection
looks like the safe side and is not: a user whose packs are always rejected gets no
drafts at all, and the whole pack is the unit of rejection. Names need a name list to
detect, the Mac has one (it has the address book), and guards one and three both cover
this. Guard two cannot, without a heuristic that is wrong in both directions.

**§ 7's 2 Aug amendment strengthens this rather than settling it.** "Name redaction must
not assume capitalization — the target corpus is lowercase texting" means the
capitalised-pair heuristic would *also* miss `"ill ask john smith about it"`, which is
the case that actually matters. So it over-rejects real exemplars and under-detects real
names simultaneously. I have kept the guard at the four mechanical patterns and made all
four case-insensitive where case could matter (the street pattern now fires on
`"10 downing st"`). Still open for you to overrule.

The four it does assert are mechanical and near-zero false positive, and it errs toward
rejecting within each: the phone pattern is looser than E.164, the amount pattern covers
`$40`, `40 dollars` and `30 usd`. `schemas.test.ts` asserts all four fire on realistic
text and that none fire on the committed fixtures or on ordinary chat.

`[prompt 04]` — **The card refuses in three cases, not just the `thin` one.** The
checklist names the `thin` fixture. I also refuse when `relationships_ranked` is under
ten and when the digest carries fewer than two archetypes. A percentage over four
relationships moves 25 points per person — it sounds precise and is not — and a card
with one archetype is a number on a black background, which nobody screenshots. All
three return a real 1080×1920 page saying what is missing, not an error, with the reason
in an `x-boi-card-kind` / `x-boi-card-reason` header so prompt 05 can decide whether to
attach one.

`[prompt 04]` — **Determinism is per-machine, and that is a deployment constraint.**
Byte-identical output within a machine is what the checklist asks for and what the tests
assert. Across machines it holds only if the font set does, since resvg resolves
`Helvetica, Arial, DejaVu Sans, Liberation Sans, sans-serif` against whatever the host
has installed. The card is meant to look the same for everyone, so **production must pin
a container image with a known font set** rather than rely on the host. The alternative
was committing a font binary to `cloud/card/`, which is a licensing decision rather than
a technical one — flagging instead of making it.

`[prompt 03]` — **The welcome message's from-handle reads `LINQ_FROM_HANDLE`.** That
variable is in `.env.example` under Track C's block, and it is the same value the
outbound fixture uses (`+15550100123`). Adding a second variable for one handle is how
two names for one thing drift apart, so I read theirs rather than appending
`BOI_FROM_HANDLE`. If the intent was that Track D owns its own sending identity, this
should become its own variable — recording it rather than deciding it.

`[prompt 03]` — **A banned line does not fail signup.** If `Channel.send` throws, the
account is still created and `users.handle_status` is set to `unreachable`. Losing the
signup would be worse than a delayed welcome, and the status column means nothing
reports success: `unreachable` is distinguishable from both `imessage` and `mismatch`,
and prompt 05 can act on it. Asserted with `StubChannel` in `banned` mode.

`[prompt 02]` — **A digest may only name a `device_id` already registered to the
caller.** The alternative — accepting any well-formed `device_id` — means the Mac can
write rows attributed to a device that never existed, and `digests.device_id` has no
foreign key to lean on. Returns `400 validation`, not `401`: the caller is who they say
they are, the body is wrong. A digest naming another `user_id` is `401`, because that
one is an authorization failure.

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

`[prompt 02]` — **The OpenAPI document has two lines that the § 3 correction outdated.**
Its `info.description` says "Every endpoint is partitioned by user_id; delete is a
partition drop", and `DELETE /v1/users/{user_id}` documents its 204 as "partition
dropped". Cascade is the mechanism, not partitioning, and `users` is now exempt from
partitioning entirely. The behaviour is right and only the prose is stale, so nothing is
blocked — but `contracts/**` is frozen and I cannot fix it. Worth correcting before
Track A reads it as a description of what actually happens.

`[prompt 02]` — **`/v1/digest`'s 409 is documented as "duplicate generated_at for this
device" but enforced per USER.** The constraint from prompt 01 is
`unique (user_id, generated_at)`. Two devices belonging to one user that generate
digests in the same second would collide, where the document implies they would not.
Per-user is the safer of the two and matches "the corpus never moves" — one Mac per user
today. Recording it because a two-Mac user is the case where the document and the
database disagree, and nobody would find out until it happened.

`[prompt 02]` — **The parallel-test collision I predicted in prompt 01 happened
immediately.** That observation said a future prompt adding a second database-touching
test file would get two workers rebuilding one database and read the result as
flakiness. Prompt 02 was that prompt, one commit later, and 41 tests failed exactly
that way. Recorded as a small piece of evidence that the observations section earns its
place — and that "documented in NOTES" is not the same as "prevented".

`[prompt 01]` — **`vitest` runs test *files* in parallel.** All the database tests are
in one file on purpose, because they drop and rebuild the schema. A future prompt that
adds a second database-touching test file will get two workers rebuilding one database
at once, and the failures will read as flaky tests rather than as the collision they
are. `vitest.config.ts` is shared and I did not touch it; the constraint is documented
at the top of `cloud/db/src/schema.test.ts` instead.
