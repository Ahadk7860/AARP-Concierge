# Boi v3 — Build State Report

**Written**: 2026-08-10
**Audience**: an agent or engineer who has never seen this build.
**Purpose**: describe what exists, what is proven, what is broken, and what needs a human.

Read `V3_ARCHITECTURE.md` §4 for the frozen interfaces. Read `INTERFACES.md` for the
cross-session log. This file tells you where the work actually stands.

---

## 1. What v3 is

Boi becomes a conversational assistant that is best at relationships and at searching your own
message history, and that **cannot fabricate facts about people**.

Three changes from v2:

1. A 900-line closed-vocabulary chat head becomes an **agent with tools**.
2. Grounding moves from generation-time templating to **post-generation verification**.
3. Derivation moves from Swift on the Mac to **TypeScript in the cloud**.

Two build sessions worked in parallel. Claude owned Tracks A, B, C, D, H, I. A DeepSeek session
owned Tracks E, F, G. That session is finished and merged.

---

## 2. Repository topology

`main` is at `82acd24`. It contains all DeepSeek work plus two database fixes.

| Branch | Ahead of main | Contents | PR |
|---|---|---|---|
| `v3/h-join` | +39 | **A, B, C, D, and main all merged.** The integration branch | [#6] |
| `v3/i-derivation` | +15 | Swift to TypeScript derivation port. Merges independently | [#4] |
| `v3/d-permissions` | +12 | macOS permissions, CI | [#3] |
| `v3/b-agent` | +7 | Agent, router, verifier | [#1] |
| `v3/a-contracts` | +3 | New schemas | [#5] |
| `v3/c-search` | +2 | Device search, gateway auth | [#2] |
| `v3/j-contracts` | +1 | §4.5 correction, heartbeat field | [#7] |
| `v3/k-graph` | +0 | Empty. Agent died before starting | — |

Worktrees live at `/Users/skylerluk/Dev/boi-v3-<letter>`.

**`v3/h-join` is the branch that matters.** It holds every Claude track except I. It is green
and pushed. It has not merged to `main` because merging may trigger a Railway deploy.

---

## 3. What each track built

### Track A — contracts (complete)
`chat_reply.v2` adds `kind: "open"` with `evidence` refs. `chat_route.v1` is
`{lane, intent?}`. Both have differential tests against ajv from day one.

`cloud/shared/src/contracts.ts` gained `EvidenceRef`, `ChatReplyV2`, `ChatReplyAny`, added
additively so v1 producers are unchanged. `ChatReplyV2` is asserted bidirectionally equal to
its zod schema at compile time, so the two cannot drift.

**Why this mattered**: `chat_reply.v2` existed and was tested for hours while **nothing used
it**. Integration found that the agent's evidence refs were computed, verified, then discarded
at the transport boundary.

### Track B — agent core and verifier (complete)
Files: `cloud/agent/src/` (16 files).

- **Router** on `gemini-2.5-flash-lite`. Returns `cache_hit | agent | refuse`. Fails closed to
  `refuse` on any unrecognised value.
- **Tool registry**, all 9 tools of §4.2. Each returns `evidence: {source,id}[]`.
- **Verifier** (`verifier.ts`) — the most important file in v3. Every person-name, handle, date
  and number in the output must appear in a tool result from **this turn**. One regenerate that
  names the violation, then degrade to a grounded summary.
- **Agent loop** — I1 is structural. `runVerifiedTurn` is the only exit.
- Evals: router 0% misclassification, verifier 0% unsupported-claim leakage.

**Four verifier defects were found and fixed.** See §5.

### Track C — search and `ask_device` (complete)
`cloud/device-search/` holds the cloud-to-Mac WebSocket gateway. `mac/Sources/BoiKit/Search*.swift`
holds the Mac handler.

FTS5 query with `handle` and date filters bound into the SQL `WHERE`, not applied afterward.
Verified against the real corpus: 97,137 messages, 566 handles, 1 to 2 ms.

Auth was a dev placeholder trusting `?user_id=`. It now requires `Authorization: Bearer` and
rejects a token for user A claiming user B. 16 tests.

### Track D — macOS permissions and CI (complete)
**The spike passed all 7 steps** on macOS 15.7.4 (24G517), including the LaunchAgent gate. A
negative control proved the NSOpenPanel grant causal: the same binary with `--direct` and no
panel got `SQLITE_AUTH`. **Boi can likely drop Full Disk Access.**

Also: Keychain headless read verified from a launchd process, CI added (Ubuntu plus Postgres
container), and the picker made the default with a local recovery notification.

**Two non-proofs, both documented**: bookmark survival across a re-signed app update is
untested and is the most likely production failure. Durability was measured over one minute.

### Track I — derivation port (session scope complete)
Nine modules ported, all differentially green against the real 97,137-message corpus:
`TextCoverage`, `Redaction`, `FactVocabulary`, `FactExtractor`, `Metrics`,
`UnderstandingBuilder`, `VoicePackBuilder` v1 and v2, `DigestBuilder`.

20 test files, 163 tests.

**Six Unicode divergence classes found**, every one invisible to hand-written tests:

| # | Divergence |
|---|---|
| 1 | Apple whitespace trim strips U+200B; JS `.trim()` does not |
| 2 | JS `\b` is ASCII-only; ICU's is Unicode-aware |
| 3 | JS `\s` includes U+FEFF; ICU's does not |
| 4 | JS `\w` is ASCII-only; ICU's is Unicode-aware |
| 5 | Swift `String.count` counts graphemes; JS counts code points |
| 6 | Swift `String.contains` matches graphemes; JS `.includes` matches UTF-16 units |

**Standing rule from this**: check the actual Swift API at each call site. Do not generalise a
Unicode fix across a module. `String.count` and `.unicodeScalars` appear three lines apart in
one function and diverge in opposite directions.

### Track H — integration (phase 1 and 2 partial)
`cloud/agent/src/inbound-bridge.ts` implements `ClosedChatPort` by calling the real
`runAgentTurn`. Wired into `cloud/phase2-runtime/compose-runtime.ts` behind
`BOI_AGENT_PATH_ENABLED`. **Flag unset keeps the old path. Fails closed.**

`cloud/agent/test/e2e-harness.test.ts` drives the whole path with scripted models that
deliberately fabricate, asserting I1 and I2.

`PostgresAgentStore` replaces the in-memory placeholder. The agent can now answer from real
tables.

### Tracks E, F, G — DeepSeek (merged)
Migrations 017 to 022, `repository-v3.ts`, R2 client and deletion, job queue plus ingest worker,
precompute cache, typing indicator, `progressive.ts`, universal binary.

---

## 4. Test state

Full suite on `v3/h-join`: **6 failed files, 27 failed tests, 826 passed of 853.**

The same 6 files and 27 tests fail on `main`. **There are no regressions.**

Known-bad, do not chase:
- `cloud/e2e/src/e2e.test.ts` — card rendering, 8 failures
- `cloud/intelligence-bridge`, `cloud/scheduler` — Python and cron environment
- `cloud/db/src/schema.test.ts` — 3 remaining, `contact_handles` never seeded
- `cloud/phase2-runtime/inbound-adapter.test.ts` — typecheck errors

Swift on `v3/d-permissions`: **396 tests, 8 failures, 2 unexpected.** The 8 need build fixtures
or a Python interpreter.

**Warning**: the local Postgres `boi_dev_d` is shared by every worktree. Whichever branch
migrates last leaves it in that shape. Local DB numbers are unreliable. CI uses a clean
container, so trust CI over local runs.

---

## 5. Bugs found and fixed

These are the reason this build is in better shape than its test counts suggest.

### Verifier, four defects
1. **Identifier digits polluted the number pool.** A `person_id` like `p_8f3a12` put `8`, `3`
   and `12` into the set of supported numbers, so "you have 12 open loops" was scored grounded
   by a hash fragment. Fixed by bucketing leaves on the key they were reached through.
2. **Empty draft shipped a blank iMessage.** Round exhaustion returned an empty draft with
   non-empty calls; the guard required both to be empty.
3. **`defaultDegrade` leaked raw `source:id` refs** into user-facing prose.
4. **Any prose word could ground a fabricated name.** `case "name"` checked one flat bag built
   from every string leaf, prose included. The word "trip" in a snippet made "Trip asked about
   the plan" verify as grounded. Fixed by grounding names only against `display`-keyed leaves.

Defect 4 is the important one. It was found by an independent audit after the orchestrator's own
review missed it.

### `repository-v3.ts` batch inserts, two bugs
Both were on `main` and would have broken production writes.

1. **Off-by-one in four functions.** `base = params.length` where SQL is 1-based, so `$1` was
   reused for both `user_id` and the first row column. The identical bug had been fixed once in
   `upsertRelationships` and left in `insertInteractions`, `upsertOpenLoops`,
   `insertDailyMetrics`, `upsertRelationshipEdges`.
2. **`upsertOpenLoops` could never insert anything.** The INSERT names 10 columns; the
   placeholder tuple generated 9.

Both survived every test because **nothing ever called these with more than one row**. A single
row hides an off-by-one in the base index. `cloud/db/src/batch-params.test.ts` closes that.

### Heartbeat rejection, production bug
`messages_access_state` was added to the live heartbeat payload. The frozen contract sets
`additionalProperties: false`, which rejects the **whole request** for one unknown field. Every
heartbeat from every real device would have failed. Caught before shipping.

### `swift test` sent real production traffic
`AppBundleTests.swift` built `SyncRun` at six call sites with no injected uploader. The default
resolved `~/Library/Application Support/Boi/.env` — real production credentials — and POSTed to
the live API. Fixed at two layers: stub injection everywhere, plus a process-level guard that
refuses the real config directory whenever XCTest is loaded.

The guard's first implementation was wrong. `XCTestConfigurationFilePath` is set by Xcode, not
by SwiftPM. Its own regression tests caught that before it was trusted.

---

## 6. Known limits and open gaps

### The harness proves aggregates, not per-item correctness
`registerFor` was wrong for the entire port and the 420-relationship differential stayed green,
because `threadRegister` averages many messages and dilutes one heart-only message to nothing.

**"Green on 420 relationships" means the aggregates agree.** A per-item function can be
systematically wrong and stay invisible. `StyleProfile`'s seven per-message predicates were
audited and are clean. `semanticShape`, `looksLikeQuestion` and `containsPlanMarker` are covered
only for sampled exemplars.

### Timezone blocks derivation cutover
Swift `ThreadStructure` reads `Calendar.current`. The cloud defaults to UTC. Measured on real
data: **28 of 420 relationships, 6.7%, get a different `relationshipKind`.**

The `users` table has a `timezone` column. The Mac does not send it and derivation does not use
it. Both are needed before cutover.

### `lifecycle_stage` and `relationship_kind` have no v3 column
They exist only on the old `contact_id`-keyed `relationships` table. `PostgresAgentStore`
returns `null` rather than inventing them, so the agent is degraded.

### Other open items
- Multi-bubble delivery still collapses to one message from live inbound traffic.
- `messages_access_state` is not on the wire, so only the local notification works.
- R2 envelope encryption is unwritten. R2 has no account, bucket or credentials, so it cannot
  run today.
- Track I: global voice pack unported. `versionForV2` is two-way, not three-way, because Python
  has no v2 implementation.
- Dual-run and cutover have not started.

---

## 7. What needs a human

1. **Merge `v3/h-join` into `main`.** Held back because a merge may trigger a Railway deploy.
2. **A live end-to-end test.** Nothing has run against a live model, a real device and real
   traffic together. This is the highest-value remaining action.
3. **Set `BOI_ROUTER_MODEL`, `BOI_AGENT_MODEL`, `BOI_AGENT_ESCALATION_MODEL` in Railway.** All
   three IDs were confirmed to exist. Production currently runs `gemma-4-31b-it`.
4. **Enable `BOI_AGENT_PATH_ENABLED`** once a live test passes.
5. **Delete the old chat path** — `selector.ts`, `reply.ts`, `waiting-on-me.ts`. Last step.
6. **The Sparkle bookmark test** on a real signed build.
7. **Timezone work**, before derivation cutover.

---

## 8. Standing rules

- **Never delete the old chat path** until a live test proves the new one.
- **`BOI_AGENT_PATH_ENABLED` stays unset** outside tests.
- **One `swift test` at a time** across all worktrees. `/tmp/boi-a` fixtures are shared.
- **Never commit real message data.** `.gitignore` says stop and report instead.
- **Verify, do not assert.** Every number must come from a command that was run.
- Commits are authored `Skyler Luk <skylerluk@gmail.com>`.

---

## 9. Progress

**About 85% to a shippable v3 behind a flag.** Every component is built and tested. Integration
is done. One live test remains.

**About 60% to v3 complete**, meaning the Swift derivation is deleted. The port is finished but
dual-run and cutover have not started, and timezone blocks them.

The honest risk: **the system has never run as a system with anything real.** Every number comes
from tests against fakes, stubs and fixtures. Expect the first live run to find real problems.
That is why the old path still exists.
