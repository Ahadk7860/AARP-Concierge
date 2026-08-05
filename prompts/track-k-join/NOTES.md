# Track K — approved-branch integration inventory

## Merge preparation

- Branch: `phase2-k-join`, based on `main` at `f46d9f0`.
- Worktree: `/Users/skylerluk/Dev/boi-imessage-track-k`.
- Merged with explicit merge commits, in dependency order: H, M, J, then approved I
  (`9c6d636`).
- No merge conflict occurred. No conflict resolution or frozen-contract change was made.
- G is intentionally absent pending its own fix/review gate.

## Validation at the three-track join

- `npm run typecheck`: pass.
- H focus: 80 tests pass across API runtime/deploy/proxy, database deploy, and card.
- M focus: 31 Swift tests pass across digest v2, understanding, contextual exemplars,
  and voice pack v2.
- J focus: 32 tests pass across closed chat, selector, reply, fabrication evaluation,
  contract round trips, and licensed follow-up drafts.
- Combined H/I/J focus after the I merge: 162 tests pass across 17 files.
- I live Postgres focus: 6 tests pass, covering encrypted handles, atomic/idempotent
  reply/no-reply claims, concurrent canonical output, exact 90-day purging, and cascade
  deletion.
- `npm run fixtures`: 20 documents pass their frozen JSON Schemas.
- `bash scripts/check-ownership.sh h|m|i|j`: pass in all four source worktrees.
- No frozen path differs from `main` in this join.

`bash scripts/check-ownership.sh k` does not distinguish a merge's inherited tree from
files authored by K, so it reports every H/M/I/J path as out of bounds. That is not a source
ownership violation—the four source-branch checks above pass—but it means the existing K
gate cannot validate an integration branch as written. The join gate needs a merge-aware
check (for example, K-authored non-merge diffs plus independently gated merge parents)
before its result can be called green.

The K worktree temporarily used the already-installed root-worktree `node_modules` for
validation; the untracked link was removed immediately afterward. The worktree is clean.

## K-01 gap inventory

### 1. SyncRun still emits and uploads v1

Track M supplied `DigestBuilder.buildV2`, `VoicePackBuilder.buildV2`, and their v2 writers,
but `mac/Sources/BoiKit/SyncRun.swift` still builds `Digest`/`VoicePack`, writes the v1
filenames, and its upload method is statically typed to the v1 models. `Uploader` likewise
has descriptor helpers only for v1. The receiving route is also still v1-only:
`cloud/api/src/schemas.ts`, `cloud/api/src/routes/ingest.ts`, and the repository row/input
types accept `Digest` and `VoicePack`, not their frozen v2 mirrors.

K-01 must wire one real v2 artifact end-to-end: mirror -> v2 builders -> exact bytes on
disk -> uploader/queue -> authenticated API validation -> Postgres JSON -> read-back. It
must assert `synced_through` survives unchanged and that no counterparty prose survives.
Whether v1 is dual-written briefly or replaced is a coordinator decision; silently
posting v2 to a v1 validator is not a migration.

### 2. H is a process, but I/J are not composed into it

`cloud/api/src/main.ts` currently owns Postgres, outbound Spectrum, registrar, key
capability creation, HTTP/card readiness, listening, and shutdown. It does not create or
own the inbound stream, checkpoint, decoder, router, encrypted private store, turn
retention worker, J selector/draft providers, or inbound reply delivery adapter.

The approved I branch now contributes these concrete internal APIs:

- `SpectrumStream`, with required injected `SpectrumStreamPort`, durable
  `SpectrumStreamCheckpoint`, and `onEvent` consumer; it reconnects only from the last
  committed opaque cursor.
- `InboundRouter`, whose required ports are decoder, strict user resolver,
  decision-only deterministic intent, J's `ClosedChatPort`, idempotent delivery, and an
  `EncryptedPrivateStore`.
- `PostgresPhase2PrivateRepository`, which owns encrypted handles, atomic canonical
  inbound/outbound claims, outbox delivery state, and exact-expiry deletion.
- `HandleVault` and `TurnVault`, which both require I's async versioned
  `HandleVaultKeyProvider` (`active` and `byVersion`). H currently exposes a different
  synchronous `{ keyId, key() }` capability, so an explicit non-leaking adapter is needed.
- `TurnRetentionWorker` plus `IntervalRetentionSchedule`; runtime must install it and own
  its stop function.
- `composeTapToSend`, which preserves copyable text and produces a link only for a valid
  resolved recipient.

K-02 must still provide concrete adapters for:

1. Photon's documented `app.messages` stream -> `SpectrumStreamPort` and
   `InboundEventDecoder` (no SDK guessing).
2. A durable, user-safe stream checkpoint. I currently defines the port but no production
   checkpoint table/adapter.
3. Existing strict user resolution and deterministic intent behavior -> I's resolver and
   decision-only ports. The existing `handleInbound` also sends, so it cannot simply be
   called as the decision-only adapter.
4. Latest stored `digest.v2` plus the matching `voice_pack.v2` -> J's closed chat and
   licensed draft gates. Recorded/offline J providers are safety fixtures, not production
   providers; a live selector/draft provider needs its own evaluated, explicitly enabled
   adapter before chat is shipping-eligible.
5. J's `ChatReply`/`DraftDelivery` -> I's idempotent Spectrum delivery and tap-to-send
   rendering, preserving the handle-unavailable copyable-text path.
6. H's key capability -> I's async versioned key provider -> `HandleVault`, `TurnVault`,
   `EncryptedPrivateStore`, and the daily retention worker over
   `PostgresPhase2PrivateRepository`.
7. Stream and retention health -> `/readyz`, and every new lifecycle stop -> the runtime's
   reverse-order cleanup stack.

### 3. Deployment composition is only two processes today

The Docker/Railway packet composes `api` and `card`. K must keep inbound listening in the
API process (or explicitly add a worker process), install migrations before either starts,
and prove that the chosen process owns exactly one stream and one retention schedule.
Readiness must go red for an unavailable listener/checkpoint/key capability without logging
message text or provider error bodies. The final live gate remains: Railway terminal
`SUCCESS`, stable TLS API hostname, private persistent card service, migration evidence,
restart/resume evidence, synthetic Spectrum inbound/outbound, and a fresh-machine Mac v2
upload.

## Ownership amendment required before K implementation

The current K ownership regex permits only `cloud/e2e/**`, `mac/Tests/Integration/**`, and
`prompts/track-k-join/**`. The necessary production seams live in `SyncRun.swift`,
`Uploader.swift`, API schemas/ingest/repository/runtime, and the I/J modules. Before K-01
or K-02 changes production code, foundation must grant explicit least-privilege paths (or
send each production edit back to its owning track). No join implementation should route
around that gate.

### Minimal merge-aware gate change

For Track K only, `changed` should not be `git diff main...HEAD`. Build it from K's
first-parent history instead:

1. For every non-merge commit on `main..HEAD`'s first-parent chain, collect its ordinary
   `diff-tree` paths.
2. For every merge commit on that chain, collect only its combined (`--cc`) diff paths.
   A clean inherited branch path equals one merge parent and disappears; a manual or
   semantic resolution that differs from both parents remains visible and is checked.
3. Sort/deduplicate that set and apply K's frozen/ownership rules to it.
4. Independently require the merged source tips' own H/M/I/J ownership gates and record
   their exact commit ids. Do not treat this as a substitute for source-track gates.

This is the smallest change that removes inherited-path false positives without making
merge conflict resolutions invisible.

### Minimal K production ownership grant

Prefer new composition adapters under one K-owned directory such as
`cloud/phase2-runtime/**`, then grant only the existing call sites and validators that
must change:

- `mac/Sources/BoiKit/SyncRun.swift`, `mac/Sources/BoiKit/Uploader.swift`, and
  `mac/Tests/BoiKitTests/UploaderTests.swift` (plus K's existing integration-test path).
- `cloud/api/src/main.ts` and `cloud/api/src/main*.test.ts` for lifecycle/readiness.
- `cloud/api/src/schemas.ts`, `cloud/api/src/schemas.test.ts`,
  `cloud/api/src/differential.test.ts`, `cloud/api/src/routes/ingest.ts`, and
  `cloud/api/src/ingest.test.ts` for the real v2 receive boundary.
- `cloud/db/src/repository.ts`, a narrowly named repository test, and one numbered
  checkpoint migration pair if the durable Spectrum cursor is stored in Postgres.
- `deploy/**`, `Dockerfile`, and `railway.toml` only if the final composition changes the
  deployed process contract.

Do not grant all of `cloud/api`, `cloud/db`, `cloud/inbound`, or `cloud/chat`: the approved
I/J APIs are sufficient for adapters, and broad ownership would make it possible for the
join to rewrite a safety gate instead of proving the seam.
