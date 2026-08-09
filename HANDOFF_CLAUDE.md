# Session Prompt — Claude Code (Opus 5 orchestrator + Sonnet 5 executors)

Paste this as your first message in a **fresh Claude Code session** at
`/Users/skylerluk/Dev/boi-imessage`.

---

## THE PROMPT

> You are the orchestrator for the Boi v3 build. Read these in order before doing anything:
>
> 1. `V3_ARCHITECTURE.md` — the build spec. §4 contains **frozen interfaces**; treat them as
>    contracts.
> 2. `AGENT_ARCHITECTURE.md` — why the design is what it is (§1 and §5A especially).
> 3. `RELATIONSHIP_MODEL.md` — the data model rationale.
> 4. `boi_remaining_work.md` — outstanding bugs, and pre-existing test failures **not** to chase.
>
> **A parallel DeepSeek session is building Tracks E, F, and G in this same repo.** You own
> **A, B, C, D, H only**. Never edit files under their ownership (§ File ownership below) —
> if you need a change there, note it in `INTERFACES.md` and keep moving against the frozen
> interface.
>
> **Read `INTERFACES.md` now, at the start of every track, and before touching any shared
> file.** It is the only channel through which you learn what the DeepSeek session changed —
> in particular `cloud/shared/src/intents.ts` (frozen intent keys, §4.2a) and
> `cloud/channel/src/progressive.ts` (the bubble sink, §4.4), both of which they create and
> you import. Append only; never rewrite or reorder existing entries.
>
> **Launch order.** Start **I, B, and D immediately and in parallel.** I is the long pole
> (derivation port) and gates every new extractor; B is the second-longest; D opens with a
> hard-timeboxed spike whose result may change the plan. **A is now a single day** — fold it
> into whoever has slack. Start **C after B's tool registry compiles**, since `search_messages`
> must match §4.2 exactly. Then H as the join.
>
> **Everything keys on `person_id`, not `contact_id`** (§4.1). For v3 with iMessage only there
> is one identity per person, so behaviour is unchanged — but the tool contracts, the verifier's
> evidence refs, and every new table use `person_id`. `contact_id` survives only as an
> `identities` row with `source='imessage'`.
>
> Use the `parallel-tracks-teams` skill if it fits; otherwise spawn teammates directly.
> Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
>
> **Model policy**: you (Opus 5) orchestrate, review, and own the verifier design. Spawn
> **Sonnet 5 at medium effort** as track executors. Escalate a track to Opus only if Sonnet
> stalls twice on the same problem.
>
> **Velocity policy — read this carefully.** We are optimizing for speed with reasonable
> quality, not for exhaustive verification. Do NOT run a full adversarial review pass on
> every change. One executor writes, tests must pass, move on. Reserve deep review for the
> verifier (Track B) and the TCC work (Track D) only — those two are where a subtle bug is
> expensive. Everything else: ship it, the tests are the gate.
>
> **Git discipline** (many agents in flight):
> - One git worktree per track, one branch per track: `v3/a-contracts`, `v3/b-agent`,
>   `v3/c-search`, `v3/d-permissions`.
> - **Commit sequentially and often** — every green test run is a commit. Never let an agent
>   accumulate more than ~45 minutes of uncommitted work.
> - Open a **draft PR per track early**, push incrementally. Do not wait for track
>   completion to open it.
> - Attribute commits to `Skyler Luk <skylerluk@gmail.com>`.
> - Never merge another track's branch yourself; H reconciles.
>
> Start by reading the docs and giving me a one-screen plan with the teammate roster and
> which track each owns. Then begin.

---

## Your tracks

### Track A — New contracts (SHRUNK)
**Branch** `v3/a-contracts`. Small — a day, not a week.

Add frozen schemas for `chat_reply.v2` (adds `kind: "open"`) and `chat_route.v1`
(`{lane: "cache_hit"|"agent"|"refuse"}`), **each with a differential test from day one**.
`cloud/api/src/differential.test.ts` shows the pattern; note that digest.v2 shipped for months
with *no* differential coverage, which is exactly how the enum drift survived.

**This track used to include Swift↔zod codegen. It no longer does.** Track I deletes
`Contracts.swift` along with the Swift digest producer, so the third mirror — and the entire
drift class — disappears rather than being managed.

### Track I — Derivation port, Swift → TypeScript ⭐ NEW, long pole
**Branch** `v3/i-derivation`. **Read `LANGUAGE_DECISION.md` in full before starting.**

Move ~3,500–4,000 lines of derivation logic from Swift to TypeScript in the cloud. The
platform half of BoiKit (5,890 lines — `chat.db`, typedstream, TCC, wake, mirror, upload)
stays Swift permanently.

**Why**: multi-source (`VISION_MULTI_SOURCE.md`) makes two implementations of "what a
relationship is" untenable — the Mac cannot derive Gmail relationships. Plus: re-analysis for
all users in hours instead of a client release, server-side debugging, and a **265 s → 2.4 s**
test loop on the code you will tune for the next year.

**Order is not negotiable:**

1. **Differential harness FIRST.** Run Swift over `~/Library/Application Support/Boi/mirror.db`
   (97,137 real messages), run TypeScript over the same, assert field-level equality across
   all 420 relationships against the known-good `digest_v2.json`. Nothing else starts until
   this is green comparing the existing implementation to itself.
2. **Port bottom-up**, each landing only when the harness is identical:
   `TextCoverage` → `Redaction` → `FactVocabulary`/`FactExtractor` → `Metrics` →
   `UnderstandingBuilder` → `VoicePackBuilder` → `DigestBuilder`.
3. **Dual-run**, cloud shadowing Swift, divergence logged and alerted. Swift authoritative.
4. **Cut over** after a week of zero divergence.
5. **Delete the Swift derivation modules and `Contracts.swift`.** This step is what keeps the
   dual-run temporary; a permanent one is the drift bug again, except silent.

**Design incremental derivation in from the start** — rolling metrics updated per new
interaction, never a full recompute. At 100k users × ~200k interactions, full reprocessing is
a wall, and retrofitting incrementality into extractors that assume a whole corpus is painful.

`UnderstandingBuilder` is calibrated — tuned thresholds, evidence floors, a measured −0.07
correlation. **Port the behaviour, not your idea of better behaviour.** Improvements come
after the harness proves parity, never during.

### Track B — Agent core ⭐ highest judgment, review this one properly
**Branch** `v3/b-agent`.

- Router on `gemini-2.5-flash-lite` (§3). Sees question text only, never relationship data.
- Agent loop with the §4.2 tool registry. Tools return `evidence` refs.
- **The verifier.** Every person-name, handle, date, and number in the output must appear in
  a tool result from this turn. Violation → one regenerate naming the violation → then
  degrade to a grounded summary. This replaces the exact-text gate and it is the single most
  important thing in v3. Treat `cloud/chat/src/fabrication.eval.test.ts` as its harness.
- Escalation to `gemini-2.5-pro` on verifier rejection, once.
- Evals: a labeled corpus of questions per lane; track misclassification and unsupported-claim
  rates as release gates.
- **Router intents come from `cloud/shared/src/intents.ts`** — DeepSeek creates it per §4.2a.
  Import it; do not edit it and do not hand-write the strings. A rename on either side is a
  silent permanent cache miss.
- **Multi-bubble handshake**: DeepSeek's Track F provides
  `openBubbleSink({scope, idempotency_key, reply_to_message_id})` returning
  `{deliver(block), end()}` (§4.4). Call `deliver()` as each bubble finalises, `end()` when
  done. **Only deliver bubbles the verifier has already cleared — never stream unverified
  prose.** Develop against a trivial in-memory stub until their file lands; the signature is
  frozen, so integration is an import swap.

**Do not delete `selector.ts` / `reply.ts` / `waiting-on-me.ts`.** They stay live until
Track H proves the verifier holds.

### Track C — Search & `ask_device`
**Branch** `v3/c-search`.

The killer feature. `message_fts` already exists in `mirror.db` — **97,137 messages, FTS
query in 1–2 ms.** The index is done; you are building the path to it.

- `ask_device` protocol per §4.3, over the persistent WebSocket.
- Mac-side handler: FTS5 query + `handle`/`sent_at` filters from the agent's hints. Filtering
  by contact before searching is precisely what Apple's search cannot do — it's the whole
  advantage.
- Ranking + snippet extraction.
- Timeout 4 s → `{ok:false, reason:"asleep"}` → agent degrades honestly ("I need your Mac
  awake for that — want me to answer when it's back?").
- Embeddings are **optional and deferred**. Ship FTS first; people usually remember a
  distinctive word. Add `NLEmbedding` only if recall proves insufficient.

### Track D — macOS permissions
**Branch** `v3/d-permissions`. **Review this one properly too — TCC bugs are silent.**

1. **Fix or revert the uncommitted `Uploader.swift` DotEnv change first.** It reads the real
   `~/Library/Application Support/Boi/.env` during unit tests and breaks 4 of them. Make the
   search root injectable; point tests at a temp dir.
2. **Spike before building (half a day, hard timebox).** Throwaway app: `NSOpenPanel` at
   `~/Library/Messages` → read `chat.db` → persist a security-scoped bookmark → quit →
   relaunch → resolve → read again → **then run it from a LaunchAgent.** That last step is
   the risky one: the scheduled `--sync` must resolve the bookmark itself or it fails
   silently at 3am. If the spike fails on our minimum macOS, stop and report — keep FDA.
3. If it passes: implement, keep `FullDiskAccess.swift` as a documented fallback, and copy
   Pally's three-step setup UI (Messages folder / Contacts / Automation, each with its own
   button and live status).
4. Credentials → Keychain, with an ACL permitting the signed binary for headless runs.

### Track H — Integration & join
**Branch** `v3/h-join`, last.

Reconcile all branches, wire router → agent → verifier → multi-bubble delivery (DeepSeek's
Track F provides the delivery primitives), run e2e, and **only then** delete the old chat
head. Update `V3_ARCHITECTURE.md` with anything that changed in reality.

---

## File ownership — do not cross

**Yours**: `cloud/agent/**` (new) · `cloud/chat/**` · `contracts/**` · `codegen/**` (new) ·
`cloud/api/src/schemas.ts` · `cloud/api/src/differential.test.ts` ·
`mac/Sources/BoiKit/{FullDiskAccess,ContactResolver,Uploader,MessageReader}.swift` ·
`mac/Sources/BoiApp/**` · new `mac/Sources/BoiKit/Search*.swift`

**DeepSeek's — do not touch**: `cloud/db/**` · `cloud/channel/**` · `cloud/brief/**` ·
`mac/scripts/**` · `mac/Package.swift` · `cloud/api/src/routes/ingest.ts` ·
`cloud/shared/src/intents.ts`

**The live old path** — `cloud/phase2-runtime/**` and `cloud/inbound/**` — is what answers
real messages today. Track B replaces it, but **it stays running until Track H**. Read it to
understand the wiring (`inbound-adapter.ts`, `router.ts`, `compose-runtime.ts`), and build the
new agent path *beside* it behind a flag rather than editing it in place. The encrypted turn
store and retention worker in `cloud/inbound/` are reused as-is by the new path — do not
reimplement them.

**Shared, coordinate in `INTERFACES.md`**: `cloud/api/src/main.ts` ·
`cloud/shared/src/contracts.ts` · `mac/Sources/BoiKit/SyncRun.swift`

For shared files: make the smallest possible edit, commit immediately, and append a line to
`INTERFACES.md` saying what you changed and why.

---

## Definition of done

- Router + agent + verifier live behind a flag, old path still available
- `search_messages` answers "what did Maya say about the trip" from device FTS
- Codegen gate green in CI; a deliberate enum drift fails the build
- NSOpenPanel path works from a LaunchAgent, or a written report saying why we keep FDA
- Draft PRs open on every track with green tests
