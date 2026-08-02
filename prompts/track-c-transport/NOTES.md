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

`[prompt 02]` **Idempotency cannot be made durable inside this track, and the DoD's
wording hides that.** The criterion is "two sends with the same `idempotency_key` result in
exactly one request reaching the mock." That is satisfied. **"The user is not texted twice"
is not**, in two distinct ways:

1. The cache is an in-memory `Map` on the `LinqChannel` instance. It dies with the process
   and is not shared across instances, so two workers — or one worker after a restart —
   send twice for one key.
2. The ambiguous outcome is uncovered. If the connection dies *after* the provider accepted
   the message, the adapter raises `UpstreamError` code `transport` and deliberately does
   **not** cache, because a request that never arrived must stay retryable. A timeout
   cannot tell those two cases apart, so a caller that retries double-texts a real person.

Neither is fixable here: the Linq subset documents no idempotency header, and sending one
would be inventing wire format. **Durable idempotency belongs to Track D** — a persisted
`(user_id, idempotency_key) -> message_id` record written before the send and settled
after, so a restart or a second replica finds it. Track D needs to know this; nothing in
`CONTRACTS.md` says it today. Also worth asking Linq whether `POST /chats` accepts an
idempotency key at all, since that would collapse the whole problem.

`[prompt 03]` **`contracts/fixtures/inbound/draft_choice_2.json` cannot be produced from
`contracts/transcripts/linq/inbound_webhook.json`.** Prompt 03's DoD says the normalized
reference body "matches `draft_choice_2.json` in every field except `provider_message_id`
and timestamps." Three more fields differ. Two I resolved without weakening anything; the
third is irreducible.

| Field | Fixture | From the webhook | Resolution |
|---|---|---|---|
| `provider` | `"mock"` | `"linq"` | `providerLabel` is config; the test sets it and the field matches |
| `user_id` | `"usr_demo0001"` | unknown handle → `null` | `resolveUser` is injectable; the test supplies one |
| `reply_to_message_id` | `"omsg_9001"` | `"lmsg_01J8ZK"` | **irreducible** |

The third is the real one. The fixture expects **Boi's own outbound message id**; the
webhook carries the **provider's** id for the message being replied to. Translating one to
the other requires a `provider_message_id -> omsg_*` lookup over messages we sent, which is
storage Track C does not own. So either:

- Track D performs that translation after normalization, and `inbound.v1`'s
  `reply_to_message_id` is documented as *provider-scoped* on arrival; or
- the fixture is wrong and should carry `lmsg_01J8ZK`.

I did not weaken the assertion to hide this. The test compares every field except the
three, and then **pins all three explicitly**, including asserting the fixture still says
`omsg_9001` — so if anyone changes either side, the test fails and this note gets revisited.
The DoD item is reported as failing as written.

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

`[prompt 04] .env.example — appended nine LINE_* variables to the Track C block:
LINE_POOL, LINE_USERS_PER_LINE, LINE_STICKY, LINE_ASSUME_ROTATION_NOTICE,
LINE_BAN_COVERED_BY_SLA, LINE_DEGRADE_ON, LINE_HEALTH_POLL_INTERVAL_MS,
LINE_INTRODUCTION_TEXT.` Each is a named stand-in for a § 11 sales-call answer, which is
the point of prompt 04. Appended inside Track C's own block; nothing reordered.

`[prompt 02 corrections] .env.example — appended six Track C variables to the existing
"Track C: transport" block: LINQ_LINE_ID, CHANNEL_RATE_LIMIT_MAX,
CHANNEL_RATE_LIMIT_INTERVAL_MS, CHANNEL_RATE_LIMIT_BEHAVIOUR, CHANNEL_REQUEST_TIMEOUT_MS,
CHANNEL_CAPABILITIES.` Four were requested; `CHANNEL_RATE_LIMIT_BEHAVIOUR` and
`CHANNEL_CAPABILITIES` are the other two knobs the adapter reads, and leaving them out
would have left the file claiming a complete picture it did not have. Strictly appended
inside Track C's own block — nothing reordered, nothing else touched.

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

`[prompt 04] needed a port for the line-health suite — used 3035`, inside Track C's
assigned 3030–3039 range. Separate from 3032 so prompt 02's and prompt 04's suites can run
concurrently without contending for a socket.

`[prompt 02 corrections] needed a second throwaway port — used 3034`, inside Track C's
assigned 3030–3039 range. It runs a stub server that returns error bodies the mock
deliberately does not serve (an unclassifiable 503, a differently-worded ban, a platform
500), so the error-mapping paths can be tested without making the mock lax.

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

`[prompt 04] → Track D: line state is in-process and must be persisted.`
`LineRegistry.snapshot()` / `restore()` define the shape. Losing it on restart is not a
cache miss — every user gets the "this is Boi, new number" message again, from a number
that did not change. Assignments, introductions and per-line status all need to survive.

`[prompt 04] → Track D: consume line.health_changed as news, not as a status feed.` It
fires on a transition only. Payload is exactly `CONTRACTS.md` § 4.

`[prompt 04] → Track D: the fallback Channel is yours to wire.` `RoutedChannel` takes any
`Channel` as the fallback and the tests use the foundation's `StubChannel`. Twilio is a
later round.

`[prompt 03] → Track D: RAW BYTES ARE MANDATORY on POST /v1/webhooks/{provider}.`
**This will break in production and look like a signature bug.** You own that endpoint.
Fastify's default JSON parser hands the route an already-parsed object, and
`normalizeInbound` refuses one — it cannot verify a signature against bytes that were never
on the wire, because key order and whitespace normalize away. Register a raw-body
content-type parser **ahead of** the JSON parser and pass the exact bytes received:

```ts
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  try { done(null, JSON.parse(body as string)); } catch { done(null, undefined); }
});
// then:
channel.normalizeInbound(req.rawBody, req.headers["x-boi-signature"]);
```

Getting this wrong throws `RawBodyRequiredError` (code `raw_body_required`), deliberately
**not** `SignatureError` — see `## Prompt 03 corrections`. The message names the fix.

`[prompt 03] → Track D: provider ids and Boi ids are different namespaces.`
`inbound.v1`'s `provider_message_id` and `reply_to_message_id` both carry the **provider's**
ids (`lmsg_...`). Boi's own outbound ids are `omsg_...` (`CONTRACTS.md` § 6). Nothing
translates between them today, and nothing in `CONTRACTS.md` says so. A brief that sent
`omsg_9001` and gets a reply referencing `lmsg_01J8ZK` will not join unless you keep the
`SendResult.message_id -> omsg_*` mapping at send time — `SendResult.message_id` is the
provider's id, so that mapping is the only place the link exists. This is the same gap as
the `draft_choice_2.json` mismatch in `## Contract gaps`, seen from Track D's side.

`[prompt 03] → Track D: reply_to_message_id arrives provider-scoped.` A normalized
`inbound.v1` carries the provider's id for the replied-to message (`lmsg_...`), not Boi's
own (`omsg_...`). See `## Contract gaps`. Also: inject `resolveUser` if you want `user_id`
populated — pairing is yours, and without a resolver it is null, which the schema allows.

`[prompt 02] → Track D: durable idempotency is yours.` See `## Contract gaps`. The
adapter's cache is in-process and cannot survive a restart or span replicas.

`[prompt 02] → Track D: branch on the typed errors, not on strings.` `LineBannedError`,
`RateLimitedError` (with `.local` distinguishing our limiter from the provider's 429),
`LineUnavailableError`, `UpstreamError`, `CapabilityError`, `EmptyMessageError`, all
exported from `cloud/channel/src/errors.js`. Branch on `code` (a closed, provider-neutral
union) and `retryable`. **Never branch on `diagnostic`** — that holds Linq's own slug and
HTTP status, for logs only. `LineBannedError` is a migration event, never a retry.

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

## Prompt 02 — audit corrections

An audit reported that prompt 02's suite never compiled and therefore never ran. **That
finding did not reproduce**, and the evidence says the audit ran against a tree that had
the prompt-02 adapter alongside the *pre-correction* prompt-01 mock:

- `bash scripts/gate.sh c` is green at HEAD: typecheck clean, 57 tests executed across two
  files, lint clean, fixtures valid, ownership OK, no skipped suites.
- The three symbols the audit cited — `pathPrefixes`, `loadTranscripts`, and the test named
  "serves both the transcript path…" — have **zero** occurrences at HEAD and exist only at
  `2d4189e~1`, the commit before the prompt-01 corrections. `2d4189e` is an ancestor of
  HEAD.
- The two quoted `tsc` errors are exactly what the prompt-02 test produces against that
  older mock: `DEV_TOKEN` was not exported and the field was still `pathPrefixes`.

So step 1 of the instruction — "apply the three prompt-01 corrections for real" — was not
performed, because they were already applied in `2d4189e` and re-applying them would have
meant fabricating a no-op commit. The rest of the instruction was performed in full.

**The four substantive findings were all real at HEAD, and all are fixed.** Nothing here
was a false alarm; a stale checkout does not make a design flaw less true.

### a. Idempotency limits — recorded, not silently patched

Recorded as a contract gap for Track D (see `## Contract gaps`). Both failure modes are
now stated in `cloud/channel/README.md` under the DoD wording they violate: the criterion
is "one request reached the mock", not "the user was not texted twice". Not fixed here
because durable idempotency needs storage this track does not own, and inventing an
idempotency header would be inventing wire format.

### b. Provider semantics leaked through the error surface

`UpstreamError.code` carried Linq's own slug (`line_degraded`, `upstream`) or
`http_<status>` — and the README told Track D to branch on it. Provider coupling wearing a
neutral name.

Fixed structurally rather than by convention: `ChannelError.code` is now a **closed union**
(`ChannelErrorCode`), so `tsc` rejects a provider slug there. The vendor's slug and HTTP
status moved to `diagnostic: ProviderDiagnostic`, documented log-only. A test collects a
real error from every failure path and asserts each `code` is in the neutral set and none
matches `/^http_/`.

The lesson for my own checking: the leakage criterion I ran was a key-set assertion on
`SendResult` plus a filename grep. Both were blind to the error surface, which is the other
half of what crosses the boundary. A structural check — a closed type — is worth more than
either, because it cannot be forgotten.

### c. Ban detection was exact-match while health() was tolerant

`send()` raised `LineBannedError` only on `failure.error === "line_banned"`, a body nobody
has ever seen; anything else fell through to an error the README marked retryable, so Track
D would have retried a banned line. Meanwhile `health()` had a forty-line tolerant parser
for precisely this reason. The inconsistency was the bug.

Now `slugLooksBanned` tokenizes the slug and matches the same `BANNED_WORDS` vocabulary
`health()` uses, so `account_suspended`, `LINE_BLOCKED` and `line.banned` all raise
`LineBannedError`. Both call sites share it.

A 503 that still cannot be classified raises the new `LineUnavailableError`:
`retryable: false`, and the message tells the caller to consult `health()`. Raising
`LineBannedError` there would trigger a migration on a guess; marking it retryable would
hammer a line that may already be banned. Same discipline as `health()` returning
`degraded` rather than `up` on an unparseable body — do not resolve an ambiguity by
picking the convenient answer.

### d. capabilities() was hardcoded, and three flags are dead

The comment claimed sales-call answers "land here and not in a code change" while the
values were a frozen literal with no env path. That comment was false as written.

`CHANNEL_CAPABILITIES="groups=1,threading=0"` now overrides them, and an unknown key or
unparseable value throws rather than being ignored — a silently-dropped override is a
config change that looks applied and is not.

And the honest part: **`tapbacks`, `richlinks` and `typing` gate no code path anywhere.**
No outbound block produces them, nothing reads them. They exist because the frozen
`Capabilities` type has those fields. "Capability negotiation, not assumption" is real for
`groups`, `images`, `contact_cards` and `threading`, and **vacuous** for the other three
until something uses them. Stated in the README and asserted by a test that flips all three
and shows the wire payload is byte-identical, so the criterion cannot keep looking green on
their behalf.

## Prompt 03 — inbound

Verify first, then parse. An unverified body is attacker-controlled input, so nothing
interprets the contents until the bytes are authenticated. Asserted by a mutation: deleting
the verify call fails four tests.

### The split

`inbound.ts` is provider-neutral — verification strategies, `inbound.v1` assembly, the
`user_id` rule, the timestamp rule. The Linq-specific part (which key holds the id, what
the type strings are) is `extractLinqWebhook` in `linq-channel.ts`. A second provider is a
new extractor, not a change to the normalizer, and there is a test that drives `normalize`
with a Twilio-shaped extractor to prove the seam is real rather than asserted.

**This regressed prompt 02's leakage grep and I fixed it rather than restating the
criterion.** My first draft of `inbound.ts` and `errors.ts` named the vendor in comments, so
`grep -rn 'linq' cloud/channel/src --include=*.ts -il` matched four files instead of one.
The comments now say "the provider". Of the non-test sources only `linq-channel.ts` matches;
the two test files match, which is expected since they test the Linq adapter. Worth noting
because the criterion caught something a human reviewer would likely have waved through —
comments are exactly where vendor knowledge leaks back in.

### Decisions

- **An unknown `type` is refused, never defaulted to `text`.** Defaulting would turn a read
  receipt into a message with null text, and Track D would treat provider noise as
  something a person said. That is the fabrication failure arriving through the back door.
- **Text is only carried on a text-bearing kind.** A read receipt with a stray `text` field
  normalizes to `text: null`.
- **A `reaction` field beats a `type` of `message`.** The stronger signal wins, so a
  tapback delivered as a generic message event is still a tapback.
- **A parsed object is refused outright.** Re-serializing to verify would compare against
  bytes that were never on the wire. The refusal has its own message telling the caller to
  pass raw bytes.
- **An invalid or absent provider timestamp falls back to our own receipt time**, not null:
  the schema requires `received_at`, and "we received it now" is a true statement. A
  malformed one is not silently trusted.
- **`trace_id` is validated as a W3C traceparent** and dropped if it is not one. Passing
  through an arbitrary string would put unvalidated provider data in an observability field.
- **`SignatureError` and `InboundParseError` are separate classes with separate codes.** One
  is a security event worth alerting on, the other is schema drift worth a bug report.

### Mutation testing

Five mutations, all caught: inverting verify/parse order (4 tests), replacing
`timingSafeEqual` with `===` (1), re-serializing before verifying (2), defaulting an unknown
type to `text` (1), and collapsing the two error codes into one (1).

The constant-time assertion is a source-text check on
`return timingSafeEqual(expected, actual);`. That is a weaker kind of test than the rest —
it asserts the implementation rather than the behaviour — but timing behaviour cannot be
asserted reliably in a unit test, and the alternative is no check at all. Flagging the
weakness rather than letting it read as equivalent to the others.

## Prompt 03 corrections

**`RawBodyRequiredError` split out of `SignatureError`.** Passing a non-`Buffer`,
non-string body used to throw `SignatureError`, so a caller's programming error — Track D
forgetting a raw-body parser — surfaced as a forged-webhook alert.

That is precisely the conflation `SignatureError` and `InboundParseError` exist to prevent,
pointing the other way, and it is the more dangerous direction: **a security alert that is
really a config bug trains people to ignore the alert.** Every inbound webhook would fail
on day one of production, the dashboard would show a flood of signature failures, and the
real cause is one missing content-type parser.

Now its own class with code `raw_body_required`, `retryable: false`, and a message that
names the fix rather than describing the symptom. The test asserts it is a
`RawBodyRequiredError` and explicitly **not** a `SignatureError`, and covers `42`, `null`,
`undefined`, an object and an array.

Recorded for Track D under `## Requests to other tracks`, with the Fastify parser they need.

## Prompt 04 — line health

### The § 11 config map, which is the point of this prompt

| § 11 | Question | Config value | Default, and why |
|---|---|---|---|
| 3 | real rate limits | `CHANNEL_RATE_LIMIT_MAX`, `CHANNEL_RATE_LIMIT_INTERVAL_MS`, `CHANNEL_RATE_LIMIT_BEHAVIOUR` | 30/60s, delay — far above one brief per user per day, far below anything that reads as automation |
| 4 | does the SLA cover a line-level ban? | `LINE_BAN_COVERED_BY_SLA` | `false` — assume it does not, so a ban migrates users off immediately |
| 5 | is a line sticky indefinitely? | `LINE_STICKY` | `true` for our behaviour, but rotation is built as a first-class migration because we assume the provider does not guarantee it |
| 6 | are we notified before a rotation? | `LINE_ASSUME_ROTATION_NOTICE` | `false` — detect reactively and always re-introduce |
| 7 | tenants per line, can we buy dedicated? | `LINE_USERS_PER_LINE`, `LINE_POOL` | `5` — cost is linear in lines, ban risk is super-linear in users per line |

Plus `LINE_DEGRADE_ON`, `LINE_HEALTH_POLL_INTERVAL_MS`, `LINE_INTRODUCTION_TEXT`.

**Every default is the pessimistic reading** — the assumption that costs least if wrong —
and there is a test asserting exactly that, so an optimistic default cannot drift in
unnoticed. Unparseable values throw rather than falling back to a default: a silently
ignored config change looks applied and is not.

### Decisions

- **The downgrade rule is one set, `DOWNGRADE_ON_CODES`, and only line-level codes are in
  it.** A rate limit is our own throttling; a malformed response is our bug; a 500 is the
  platform. Burning the fallback on any of those spends a second provider's quota to hide a
  signal we need.
- **A known-banned line gets no attempt at all**, rather than one doomed try first.
  Retrying a banned line is what deepens the ban.
- **The introduction is committed after the send succeeds.** Marking before would let a
  failed send burn it, leaving a user permanently un-introduced — silently receiving
  messages from an unknown number forever.
- **The registry refuses to over-pack a line** when the pool is exhausted, rather than
  exceeding tenancy. Silently adding one more user is the wrong degradation when ban risk
  is super-linear in tenancy.
- **A health source that throws yields `degraded`, not `up`.** Same rule as the adapter's
  `health()`.
- **The monitor owns no timer.** `poll()` is called by the caller. A background interval
  inside a library is unstoppable in tests and invisible in production.
- **Migration returns a record** with a reason (`initial` / `rotation` / `health`) rather
  than silently reassigning. It is the moment the product has to say something to a person.

### The mutation that was not caught, and what it revealed

Seven mutations; six failed a test immediately. **The seventh did not**, and that was the
useful one: removing the `err.retryable` guard in the catch block changed no test result,
because a second guard below it (`err.code !== "line_unavailable"`) was already doing the
work. Two overlapping conditions, one of them dead — **redundant logic that reads as
protected when only the other branch is load-bearing.**

Replaced both with a single explicit `DOWNGRADE_ON_CODES` set and a test that pins the
routing decision for all eight error classes. Re-mutated in both directions — widening the
set to include `rate_limited` fails three tests, narrowing it to drop `line_unavailable`
fails one.

I would not have found this by reading the code; the mutation found it. Worth keeping as
the argument for mutation-testing every criterion rather than the ones that feel risky.

### One thing the prompt did not anticipate

The 100-consecutive-sends stickiness test hits the **real rate limiter** — 30/minute with
`delay` — and sat for two minutes before timing out. The limiter was behaving correctly.
I raised `CHANNEL_RATE_LIMIT_MAX` in that test's channel config, which is configuration
rather than a weakened assertion; the limiter's own behaviour is asserted separately in
`linq-channel.test.ts`.

Worth noticing for real operations though: at the shipped default, a backfill or a retry
storm across many users on one line will serialize behind the limiter. That is the intended
trade, but it means throughput is bounded per line, and **capacity planning is lines, not
workers**.

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
