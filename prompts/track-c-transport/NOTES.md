# Track C — Notes

Running log for this track. The user reads this alongside the commit history when
reviewing. Append; do not rewrite history here.

This file is how you talk to the user, since you cannot talk to the other agents.
Everything you want to say to somebody outside this worktree goes here.

## Blockers

Anything that stopped progress. For each: what you were doing, what you expected, what
happened, what you tried, and whether it is still open.

Format: `[prompt NN] <OPEN | RESOLVED> — <what and what you tried>`

`[prompt 01] OPEN — npm run lint cannot pass, and the fix is out of Track C's bounds.`

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

**What the user needs to decide:** who owns `eslint.config.js`. It is a foundation-owned
shared file that does not exist yet. Suggested resolution: the user adds it to `main` and
appends it to the `SHARED` regex in `scripts/check-ownership.sh`, then instructs each track
to `git merge main`. Separately, `--ext .ts` is itself a removed ESLint 9 flag — currently
ignored, but it will start erroring.

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

Resolved locally without touching anything frozen: the mock serves **both** prefixes
(`MOCK_LINQ_PATH_PREFIXES`, default `/api/partner/v3,`). No request or response shape
changes, so nothing diffable is hidden. The user should still decide which is canonical
before prompt 02 encodes an assumption — the consistent value is
`LINQ_BASE_URL=http://localhost:3031/api/partner/v3`.

No other gap. Every contract prompt 01 needed was present and sufficient.

## Shared file changes

Every append to a foundation-owned shared file: dependency manifests, lint config,
`.env.example`. One line each, so the user can anticipate merge conflicts.

Format: `[prompt NN] <file> — added <what> because <why>`

**None.** No shared or foundation-owned file was modified. Prompt 01 needed no new
dependency: fastify and undici were already in `package.json`.

One thing to know: `npm install` rewrites `package-lock.json` — it adds `"peer": true` to
eight entries, incidental npm-version churn with no dependency change. That is a mutation,
not an append, so I restored it with `git checkout -- package-lock.json`. Expect the same
churn in any worktree that runs `npm install`.

## Runtime resources

Any port, database, cache directory, container name, external path, or rate-limited
credential you needed that `CONTRACTS.md` § 9 does not assign to you. Do not pick a
default — another track may pick the same one. Record it and report.

Format: `[prompt NN] needed <resource> — used <what> provisionally / blocked`

`[prompt 01] needed a webhook receiver port for the signature tests — used 3033`, inside
Track C's assigned 3030–3039 range, so it is assigned-by-range rather than borrowed.
`3032` is left free for the channel test server in prompt 02.

The test suite drives the mock through `fastify.inject()` rather than a socket, so it binds
exactly one real port (3033) and running it never collides with a hand-run server on 3031.
No database is used; line state is in-process, as `TRACK.md` anticipated. `/tmp/boi-c`
holds only verification logs.

## Requests to other tracks

Things another track owns that you need. You cannot reach across and do it yourself.
Record it, report it, and continue with a local workaround only if the workaround is
visible and reversible.

Format: `[prompt NN] → Track <X>: <what you need and why>`

`[prompt 01] → foundation/user: create eslint.config.js.` See `## Blockers`. Track C
cannot, and no track can — it is outside every track's owned set.

`[prompt 01] → foundation/user: decide the canonical LINQ_BASE_URL.` See
`## Contract gaps`. Workaround is visible and reversible: the mock serves both prefixes,
and removing one is a one-line config default.

Nothing is needed from Track A, B, or D. Prompt 01 reached a green checklist using only
the foundation stubs and Track C's own code, as `CONTRACTS.md` § 10 requires.

## Deviations from the plan

Anywhere the implementation departs from what the prompt described, and why. A
deviation is not a failure — an unrecorded one is.

Nothing was weakened, skipped, loosened, or lowered. No existing test, assertion, lint
rule, threshold, or type was modified, and no test is skipped or pending. The items below
are additions a working server required but the prompt did not specify.

1. **Two path prefixes served.** See `## Contract gaps`.

2. **The mock replays the transcripts rather than paraphrasing them.** It loads
   `contracts/transcripts/linq/*.json` at startup; a request body that deep-equals a
   recorded request is answered with that transcript's recorded response verbatim, and
   `banned` mode returns the recorded `503` body verbatim. Anything unrecorded gets a
   deterministic synthesized response of the same shape, tested separately. This was the
   only way to make "matches the transcript field for field" a real assertion — the
   recorded `id` (`lmsg_01J8ZK`) and `trace_id` cannot be reproduced by a generator, so any
   other approach would have meant weakening the criterion to a shape check.

3. **Multi-recipient sends are rejected with `400`.** Group chats exist in the Linq API and
   are deliberately out of MVP scope on consent grounds (prompt 01). The mock refuses them
   rather than pretending to fan out, so a group send cannot pass silently in a test.

4. **`server.ts` is a single self-contained file.** Node's type stripping does not resolve
   `./x.js` to `x.ts`, and there is no build step, so an entry module that must start with
   `node cloud/mock-linq/src/server.ts` cannot carry relative imports. Splitting config,
   signing, and the recorder into modules would satisfy taste and break the DoD's run
   command. Tests import it normally; vitest resolves `./server.js` to the `.ts` source,
   which is the same pattern the foundation's own `contracts.test.ts` uses.

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
| token validation | any non-empty bearer, unless `MOCK_LINQ_EXPECTED_TOKEN` is set | no token exists to validate against |
| which endpoints faults apply to | `POST /chats` only; `/lines` reports the injected mode as line status | a fault mode models a *line*, not the platform |

A real rate-limited platform would plausibly rate-limit reads too. If it does, that is a
config change, not a rewrite.

**Every § 11 sales-call answer lands in config, not in a branch**, as `TRACK.md` requires:

| § 11 | Question | Where the answer lands |
|---|---|---|
| 2 | webhook signature scheme | `LINQ_WEBHOOK_SECRET`, and the `signBody` / `verifySignature` pair |
| 3 | real rate limits | `MOCK_LINQ_RETRY_AFTER` |
| 7 | tenants per line, dedicated lines | `MOCK_LINQ_LINE_ID` |
| 8 | `GET /lines` health shape | implemented as the spec guesses it; prompt 02's `health()` must tolerate a different shape |

Items 4, 5 and 6 (does the SLA cover a line-level ban; is a line sticky; are we warned
before rotation) do not bind on prompt 01 — they land in prompt 04's line-health config.

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
