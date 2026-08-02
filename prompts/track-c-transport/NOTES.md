# Track C — Notes

Running log for this track. The user reads this alongside the commit history when
reviewing. Append; do not rewrite history here.

This file is how you talk to the user, since you cannot talk to the other agents.
Everything you want to say to somebody outside this worktree goes here.

## Blockers

Anything that stopped progress. For each: what you were doing, what you expected, what
happened, what you tried, and whether it is still open.

Format: `[prompt NN] <OPEN | RESOLVED> — <what and what you tried>`

`[prompt 01] RESOLVED by foundation commit 548d125 — npm run lint could not pass; eslint.config.js did not exist.`

Resolved 2 Aug: the foundation added `eslint.config.js`, changed the script to `eslint .`
(dropping the removed `--ext` flag), and Track C merged it forward. `npm run lint` now exits
0. The original report is kept below because the history is what gets reviewed.

One Definition of Done item for prompt 01 is red because of this.

- What I was doing: running the DoD item `npm run lint && npm run typecheck`.
- What I expected: exit zero.
- What happened: exit 1, before any file is read.

```
ESLint: 9.39.5
ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
```

The foundation commit ships the `"lint": "eslint . --ext .ts"` script and the eslint 9,
`@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` devDependencies, but no
`eslint.config.js`. ESLint 9 removed the `.eslintrc` cascade and made a flat config file
mandatory, so the script fails for **every** track, on a clean checkout of `main`, with no
track code involved. It is a foundation gap, not a Track C defect.

What I tried, and why I stopped:

1. Creating `eslint.config.js` at the repo root. This fixes lint immediately — but
   `eslint.config.js` is not in `scripts/check-ownership.sh`'s owned set for track `c`
   (`^cloud/(channel|mock-linq)/`) and not in its append-only `SHARED` set either, so the
   ownership DoD item would then fail with `OUT OF BOUNDS: eslint.config.js`. The two DoD
   items are in direct conflict: satisfying one fails the other.
2. Placing a config inside `cloud/mock-linq/`. ESLint 9 resolves the flat config from the
   working directory, and `npm run lint` runs `eslint .` from the repo root, so a config
   inside an owned path is never found.

Per `TRACK.md` ("escalate immediately, rather than working around, when ... the Definition
of Done cannot be satisfied as written") I did neither and am reporting instead.

**Track C's own code is lint-clean, and this was verified.** I wrote a temporary, untracked
`eslint.config.js` at the root with `@typescript-eslint`'s `recommended` rules, ran
`npm run lint`, got exit 0 with zero findings, and deleted the file in the same shell
command. Nothing was committed; the working tree was left as found.

**Outcome:** the user added `eslint.config.js` to `main` and fixed the script. Nothing is
outstanding.

## Contract gaps

Anything `prompts/CONTRACTS.md` does not specify, specifies wrongly, or specifies in a
way that does not work in practice. You may not edit it — record it here and report.
Every entry names the prompt where it surfaced.

`[prompt 01]` **The mock's base URL and the mock's paths disagree inside the frozen
contract set.** `contracts/transcripts/linq/*.json` record the send path as
`/api/partner/v3/chats`, and prompt 01 names that path explicitly. The same OpenAPI
document lists the mock server as `http://localhost:3031` with a path of `/chats`, and
`.env.example` sets `LINQ_BASE_URL=http://localhost:3031` while production is
`https://api.linqapp.com/api/partner/v3` — which already contains the prefix. Under the
transcript reading alone, prompt 02's adapter would hit `localhost:3031/chats` and 404, and
"swapping `LINQ_BASE_URL` is the only diff when a token arrives" would be false.

**RESOLVED 2 Aug** as `CONTRACTS.md` § 11 item 1b: `LINQ_BASE_URL` includes the prefix.
`.env.example` now ships `http://localhost:3031/api/partner/v3`.

My interim fix — serving both prefixes — was **wrong, and is corrected**. Answering both
readings is precisely the discrepancy the mock exists to surface: an adapter built against
the wrong base would have passed every test here and 404'd on the first live send. The mock
now serves `/api/partner/v3` and only that prefix (`MOCK_LINQ_PATH_PREFIX`), and a test
asserts that `/chats`, `/v3/chats` and `/partner/v3/chats` all 404. The lesson generalizes:
when the contract is ambiguous, the mock must pick one reading and record it, never satisfy
both.

`[prompt 02]` **`outbound.v1` carries no recipient handle, so a `Channel` cannot address
a message on its own.** The schema has `user_id` and is closed (`additionalProperties:
false`), so the handle cannot travel inside the message — which is *correct* privacy design
(§ 3: the server never holds a raw handle for anyone but the account holder) but leaves the
adapter unable to fill `to`.

Resolved without touching anything frozen: `LinqChannel` takes an injected
`resolveHandles(user_id) => string[]`. Track D owns the users table and supplies it. This
needs to be in `CONTRACTS.md` before Track D wires the two together, because right now
nothing tells Track D that the constructor requires it.

`[prompt 02]` **`SendResult.line_id` is required, but the documented `POST /chats` 200
response has no line field** — only `id`, `status`, `protocol`, `trace_id`. So the adapter
cannot report which line actually carried a message. It falls back to a configured
`LINQ_LINE_ID`, which is a guess dressed as a fact whenever more than one line exists.

This matters more than it looks: a line-level ban is the failure mode that actually hurts,
and attributing a send to the wrong line is exactly the datum you need to be right when
diagnosing one. Either the real response carries a line (resolve on the first live send,
§ 11 item 1) or `line_id` should be nullable in the contract. Prompt 04 will hit this.

No other gap. Every contract prompts 01 and 02 needed was present and sufficient.

## Shared file changes

Every append to a foundation-owned shared file: dependency manifests, lint config,
`.env.example`. One line each, so the user can anticipate merge conflicts.

Format: `[prompt NN] <file> — added <what> because <why>`

`[prompt 01 corrections] package.json — added devDependency "yaml": "^2.9.0" because the
rewritten conformance test parses contracts/openapi/linq-v3-subset.yaml and asserts each
response against the schema the spec declares.` Node ships no YAML parser, and `js-yaml` is
present only transitively via eslint — too fragile to hang a contract assertion on.

`[prompt 01 corrections] package-lock.json — regenerated with npm install --package-lock-only.`

Both appends are strictly additive: one line added to the end of `devDependencies`, 26
lines added to the lockfile, nothing reordered. Note that `npm install --save-dev` **cannot**
be used here — it alphabetically re-sorts every dependency block and un-escapes the
`description`, which is a restructure, not an append. I reverted that and hand-added the
single line instead, then regenerated the lockfile with npm as the rule requires.

Otherwise none. The server itself needed no new dependency: fastify and undici were already
in `package.json`, and `yaml` is test-only.

One thing to know: `npm install` also rewrites `package-lock.json` with incidental
npm-version churn (`"peer": true` on eight entries, no dependency change). Expect that in
any worktree that runs `npm install`.

## Runtime resources

Any port, database, cache directory, container name, external path, or rate-limited
credential you needed that `CONTRACTS.md` § 9 does not assign to you. Do not pick a
default — another track may pick the same one. Record it and report.

Format: `[prompt NN] needed <resource> — used <what> provisionally / blocked`

`[prompt 01] needed a webhook receiver port for the signature tests — used 3033`, inside
Track C's assigned 3030–3039 range, so it is assigned-by-range rather than borrowed.
`[prompt 02] needed the channel test server port — used 3032`, which `CONTRACTS.md` § 9
assigns to Track C by name.

The test suite drives the mock through `fastify.inject()` rather than a socket, so it binds
exactly one real port (3033) and running it never collides with a hand-run server on 3031.
No database is used; line state is in-process, as `TRACK.md` anticipated. `/tmp/boi-c`
holds only verification logs.

## Requests to other tracks

Things another track owns that you need. You cannot reach across and do it yourself.
Record it, report it, and continue with a local workaround only if the workaround is
visible and reversible.

Format: `[prompt NN] → Track <X>: <what you need and why>`

`[prompt 01] → foundation/user: create eslint.config.js.` **DONE** in 548d125.

`[prompt 01] → foundation/user: decide the canonical LINQ_BASE_URL.` **DONE** — resolved as
§ 11 item 1b, and the mock now serves that one prefix only.

`[prompt 01 corrections] → foundation/user: consider adding LINQ_API_TOKEN=linq-dev-token to
.env.example.` The mock now requires the token exactly and defaults to `linq-dev-token`, so
a fresh `.env` copied from the example has an empty token and gets 401s until it is set. I
did not append it myself — `.env.example` ships `LINQ_API_TOKEN=` deliberately empty with a
comment explaining it is not provisioned, and overwriting that value is an edit rather than
an append. Documented in `cloud/mock-linq/README.md` instead.

`[prompt 02] → Track D: LinqChannel's constructor needs a handle resolver.`
`new LinqChannel(config, { resolveHandles })`, where `resolveHandles(user_id)` returns the
recipient handles for that user. `outbound.v1` cannot carry them. Nothing in `CONTRACTS.md`
tells Track D this yet — see `## Contract gaps`.

`[prompt 02] → Track D: branch on the typed errors, not on strings.` `LineBannedError`,
`RateLimitedError` (with `.local` distinguishing our limiter from the provider's 429),
`UpstreamError`, `CapabilityError`, `EmptyMessageError`, all exported from
`cloud/channel/src/errors.js`. `LineBannedError` is a migration event, never a retry.

Otherwise nothing is needed from Track A, B, or D. Prompts 01 and 02 reached a green
checklist using only the foundation stubs and Track C's own code, as `CONTRACTS.md` § 10
requires.

## Deviations from the plan

Anywhere the implementation departs from what the prompt described, and why. A
deviation is not a failure — an unrecorded one is.

Nothing was weakened, skipped, loosened, or lowered. No existing test, assertion, lint
rule, threshold, or type was modified, and no test is skipped or pending. The items below
are additions a working server required but the prompt did not specify.

1. ~~**Two path prefixes served.**~~ **Corrected 2 Aug — reverted to one.** See
   `## Contract gaps`.

2. ~~**The mock replays the transcripts rather than paraphrasing them.**~~ **Corrected
   2 Aug — replay removed entirely.** Original text kept below; what replaced it is in
   `## Corrections to prompt 01`. It loads
   `contracts/transcripts/linq/*.json` at startup; a request body that deep-equals a
   recorded request is answered with that transcript's recorded response verbatim, and
   `banned` mode returns the recorded `503` body verbatim. Anything unrecorded gets a
   deterministic synthesized response of the same shape, tested separately. This was the
   only way to make "matches the transcript field for field" a real assertion — the
   recorded `id` (`lmsg_01J8ZK`) and `trace_id` cannot be reproduced by a generator, so any
   other approach would have meant weakening the criterion to a shape check.

3. ~~**Multi-recipient sends are rejected with `400`.**~~ **Corrected 2 Aug — removed.**
   The spec's `to` is `minItems: 1` with no maximum, so the refusal made the mock stricter
   than the contract. Group chats being out of MVP scope is a product constraint the
   composer enforces, not a property of this wire format.

4. **`server.ts` is a single self-contained file.** Node's type stripping does not resolve
   `./x.js` to `x.ts`, and there is no build step, so an entry module that must start with
   `node cloud/mock-linq/src/server.ts` cannot carry relative imports. Splitting config,
   signing, and the recorder into modules would satisfy taste and break the DoD's run
   command. Tests import it normally; vitest resolves `./server.js` to the `.ts` source,
   which is the same pattern the foundation's own `contracts.test.ts` uses.

## Corrections to prompt 01

Four defects the user caught on review of the first prompt-01 commit. All four were real;
all four are fixed in the corrections commit. Recording them because the pattern matters
more than the individual fixes: **three of the four were places the mock lied in the
direction of making my own tests pass.**

### 1. Two path prefixes → one

Serving both `/api/partner/v3/chats` and bare `/chats` meant an adapter built against the
wrong base URL would pass every test here and 404 on the first live send — the exact
discrepancy the mock exists to surface. My NOTES had identified the ambiguity correctly and
then drawn the wrong conclusion: the fix for an ambiguous contract is to pick one reading
and record it, not to answer both. Now `/api/partner/v3` only, with a test asserting
`/chats`, `/v3/chats` and `/partner/v3/chats` all 404.

### 2. The transcript-conformance test was circular

The server loaded `send_text_200.json` and replayed its recorded response; the test asserted
equality against the same file. That is `file === file` through fastify — it could not fail,
whatever the server did.

Fixed by removing transcript loading from the server entirely. `cloud/mock-linq/` now reads
nothing from `contracts/` at runtime. The test parses
`contracts/openapi/linq-v3-subset.yaml` and asserts each response against the schema the
spec declares: required keys present, **no key the spec does not define**, enum-constrained
values inside their enums. The transcript supplies the *request* and the recorded `503`
body; the spec judges the *replies*.

Two guards against the new test being vacuous in its own way:

- A negative test asserts the schema checker rejects an extra key, a missing required key,
  and an out-of-enum value. A broken checker would otherwise make every conformance
  assertion silently green.
- I mutation-tested the suite. Injecting an undefined response key, an out-of-enum
  `status`, a fixed id, and a second bare-`/chats` route each produce failures (2, 4, 1 and
  1 test respectively). Evidence is in the report.

### 3. Message ids were not unique

Transcript replay returned `lmsg_01J8ZK` for every matching send, so prompt 02's idempotency
test would have passed against a mock that could not tell two sends apart. Ids are now a
per-process counter and `trace_id` derives from the id; a test sends five times and asserts
five distinct ids and trace ids, and that none equals the transcript's recorded id.

### 4. `expectedToken` defaulted to accepting anything

Any non-empty bearer was accepted, so prompt 02 could have shipped never reading
`LINQ_API_TOKEN` and stayed green. The default is now the exact string `linq-dev-token`
(`DEV_TOKEN`), overridable by `LINQ_API_TOKEN` or `MOCK_LINQ_EXPECTED_TOKEN`. An empty
`LINQ_API_TOKEN` — which is what `.env.example` ships — means *unset* and falls through to
the dev token; only an explicit `MOCK_LINQ_EXPECTED_TOKEN=""` opts into accepting any
bearer. Tests assert a wrong non-empty bearer is a 401.

### 5. The multi-recipient `400` was stricter than the spec

`to` is `minItems: 1` with no maximum. My refusal imported a product constraint into the
wire format. **Being stricter than the spec is the same class of lie as being laxer** — both
make the mock disagree with the thing it models, and the strict direction is harder to
notice because it looks like diligence. Removed; the test now asserts a two-recipient send
returns 200.

### What I take from this

Every one of these made a test greener. The mock's job is to be the thing you diff a real
response against, and each defect quietly reduced the surface where a diff could show up.
When I next reach for "make the mock accommodate this," that is the signal to stop.

## Prompt 02 — the adapter

Nothing was weakened, skipped, or loosened. No existing test, assertion, lint rule or type
was modified; no test is skipped or pending. `@typescript-eslint/no-explicit-any` is an
error in `eslint.config.js` and there is no `any` and no `as` cast in the non-test channel
source — verified with `grep -n ': any\|<any>\| as [A-Z]' cloud/channel/src/*.ts` over
`linq-channel.ts`, `errors.ts` and `rate-limiter.ts`.

### How the no-leakage criterion was verified, both halves

The first half is the grep the prompt names: `grep -rn 'linq' cloud/channel/src
--include=*.ts -il` matches `linq-channel.ts` and `linq-channel.test.ts` and nothing else.
`errors.ts` and `rate-limiter.ts` contain no provider vocabulary at all, including in
comments — a limiter that names its callee has already leaked.

The second half — "the `Channel` return types contain no Linq-specific field" — is not
greppable, so it is verified three ways:

1. **Structurally.** `SendResult`, `Capabilities` and `ChannelHealth` are imported from the
   frozen `cloud/shared/src/contracts.ts` and `LinqChannel implements Channel`. `tsc`
   rejects an extra field on a returned object literal, so a leak cannot compile.
2. **At runtime.** A test asserts `Object.keys(result).sort()` is exactly
   `["line_id","message_id","protocol","provider"]` and that the serialized result contains
   neither `trace_id` nor `parts`. `trace_id` is the clearest tell — the mock returns one on
   every send, and it stops at `toSendResult`.
3. **By mutation.** Adding `trace_id` to the returned `SendResult` fails two tests. Evidence
   in the report.

`provider: "linq"` is not a leak: `provider` is a field the frozen contract defines, and
the foundation's own `StubChannel` sets it to `"mock"`.

### Decisions this prompt forced

- **A fourth and fifth error type.** The prompt names three. `CapabilityError` and
  `EmptyMessageError` were added because "refuse a group send" and "every block degraded
  away" are neither upstream failures nor rate limits, and folding them into `UpstreamError`
  would tell Track D the provider failed when it did not. Additions, not weakenings.
- **`RateLimitedError.local`.** Our own limiter and the provider's 429 both surface as
  `RateLimitedError`, so Track D branches once — but they warrant different responses, and
  a flag is cheaper than a sixth class.
- **Health degrades on ambiguity.** An unparseable or unreachable `GET /lines` yields
  `degraded`, never `up`. Choosing `up` would be the confident wrong answer the product
  rules forbid; choosing `banned` would trigger a migration on no evidence.
- **`normalizeInbound` throws.** Prompt 03 owns it. It throws rather than returning a
  plausible stub because the frozen contract says it never returns a partially-normalized
  message, and Track D building against fabricated inbound is a failure nobody finds until
  integration.
- **`alt` text on image blocks is dropped.** The Linq media part has `url` and `mime` and
  nowhere to put alternative text. That is a real accessibility cost, recorded rather than
  hidden, and it is a question for the sales call.
- **Idempotency is in-process only.** The subset documents no idempotency header and
  inventing one would be inventing wire format. A retry after a process restart can still
  double-send. Listed below as an open question.

### Mutation testing

Every headline criterion was checked by breaking the implementation and confirming a test
fails. Dropping the idempotency cache, attempting a group send, swallowing `Retry-After`,
mapping `503 line_banned` to a generic throw, leaking `trace_id`, and having `health()`
report `up` on an unparseable body each fail 1-2 tests. A criterion never observed failing
is a criterion that has not been tested.

## Decisions made

Choices the prompt left open that you had to resolve: a library, a data structure, an
error-handling approach. The user needs to see these before merge, because another
track may have chosen differently.

**Spec-silent behaviours the mock had to choose.** The reconstructed spec documents no
answer for any of these. Each is a guess and may be wrong against the real API; all are
cheap to change because none is load-bearing for the adapter's happy path.

| Case | Choice | Basis |
|---|---|---|
| `401` body | `{"error":"unauthorized"}` | spec gives the status, no schema; `CONTRACTS.md` § 6 |
| malformed request body | `400 {"error":"validation","detail":"..."}` | not documented at all |
| `429` body | `{"error":"rate_limited"}` | only `Retry-After` is documented |
| `GET /chats/{id}`, unknown id | `404 {"error":"not_found"}` | not documented |
| token validation | the exact string `linq-dev-token`, overridable by `LINQ_API_TOKEN` | corrected — see `## Corrections to prompt 01` item 4 |
| which endpoints faults apply to | `POST /chats` only; `/lines` reports the injected mode as line status | a fault mode models a *line*, not the platform |
| response ids | per-process counter, `lmsg_mock_000001` | unique per send, so idempotency is testable |

A real rate-limited platform would plausibly rate-limit reads too. If it does, that is a
config change, not a rewrite.

**Every § 11 sales-call answer lands in config, not in a branch**, as `TRACK.md` requires:

| § 11 | Question | Where the answer lands |
|---|---|---|
| 2 | webhook signature scheme | `LINQ_WEBHOOK_SECRET`, and the `signBody` / `verifySignature` pair |
| 3 | real rate limits | `MOCK_LINQ_RETRY_AFTER` |
| 7 | tenants per line, dedicated lines | `MOCK_LINQ_LINE_ID` |
| 8 | `GET /lines` health shape | mock implements the spec's guess; `parseHealth` tolerates five envelopes and three key names, and degrades rather than guessing `up` |

Items 4, 5 and 6 (does the SLA cover a line-level ban; is a line sticky; are we warned
before rotation) do not bind on prompts 01 or 02 — they land in prompt 04's line-health
config.

Three more for the same call, surfaced by prompt 02:

- **Does `POST /chats` accept an idempotency key?** Ours is in-process only, so a retry
  after a restart double-sends. Nothing can be done about that without a documented header.
- **Does the send response identify the line?** See `## Contract gaps`.
- **Is there any capabilities endpoint?** Capabilities are configured guesses today.

Only `MOCK_LINQ_PORT`, `MOCK_LINQ_MODE`, `LINQ_FROM_HANDLE` and `LINQ_WEBHOOK_SECRET` are
in `.env.example`. The other knobs have working defaults and were deliberately **not**
appended, because `.env.example` is foundation-owned and an append there is a merge
conflict for three other tracks over variables only Track C reads.

## Observations

Anything you noticed that the plan did not anticipate, including work that should exist
but is not in any track's scope. This is often the most useful section at review time.

1. **The ownership model has a hole the size of any root-level config file.**
   `check-ownership.sh`'s `SHARED` regex enumerates shared files by name. Any
   foundation-owned file that does not yet exist — `eslint.config.js` today, a
   `Dockerfile`, `.npmrc`, or a CI workflow tomorrow — is unownable by construction: the
   first track that needs it must either fail its ownership check or fail the check that
   needed the file. Worth widening the regex, or adding an explicit "foundation gap"
   escape that reports rather than blocks.

2. **The signature test is the one in this prompt that will actually catch a real bug.**
   Signing a re-serialized object instead of the raw bytes passes every test that builds
   its expectation the same wrong way, and then fails on the first live webhook, because
   key ordering and whitespace normalize away. The mock threads the raw buffer end to end
   and never round-trips it through `JSON.parse`/`JSON.stringify`, and the test asserts
   that a deliberately oddly-ordered body verifies against the raw bytes and **fails**
   against the canonical re-serialization. Prompt 03 must not re-derive the body it
   verifies — it has to be handed the same bytes.

3. **`GET /lines` returning one line makes a multi-line fleet untestable.** The guessed
   shape is an array, and prompt 04 (sticky assignment, automatic downgrade) will need
   several lines with mixed health to have anything to assign across. `MOCK_LINQ_LINE_ID`
   is a single value today; prompt 04 will likely need it to become a list. Flagging now
   because it is a config-shape change, and prompt 02 may build against the singular form.

4. **Node 25.2.1 runs `.ts` with no flag.** `TRACK.md`'s run command specifies
   `node --experimental-strip-types`; type stripping is on by default from Node 22.18, so
   the DoD's plain `node cloud/mock-linq/src/server.ts` is what I verified. Both work. The
   constraint that does bite is that stripping performs no module resolution, which is why
   `server.ts` has no relative imports.

5. **Nothing in this prompt proves the wire format is right.** Every test here asserts the
   mock agrees with the transcripts, and the transcripts are a reconstruction that has
   never had a response. A fully green Track C is consistent with the real API differing in
   every particular. The first real send is still the only evidence, and the mock exists to
   make that diff cheap rather than to substitute for it.
