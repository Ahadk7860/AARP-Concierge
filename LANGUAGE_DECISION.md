# Swift vs TypeScript for the Derivation Layer

**Question**: now that full content goes to R2, should `UnderstandingBuilder` and friends move
to TypeScript in the cloud?

**Answer: yes — and the window to do it cheaply is right now, before the new extractors are
written.** It is ~3 weeks, not a month, and only because a differential harness makes it
verifiable rather than faith-based.

---

## 1. The actual surface — measured, not estimated

```
mac/Sources/BoiKit total                        11,017 lines

PLATFORM-BOUND — stays Swift regardless          5,890 lines
  ChatDatabase · ChatSchema · MessageReader · TypedStream · DatabaseSnapshot
  FullDiskAccess · GrantNarrator · GrantWatcher · LaunchAgentPlist
  WakeScheduler×4 · ScanPoller · CallHistory · MirrorDatabase · MirrorSync
  Uploader · UploadQueue · DotEnv · StructuredLog · Heartbeat · SyncRun

PORTABLE LOGIC                                   5,127 lines
  FactVocabulary            840   ← 810 of those lines are quoted word data
  UnderstandingBuilder      823
  VoicePackBuilder          653
  Metrics                   563
  DigestBuilder             360
  FactExtractor             367
  Contracts                 326   ← DISAPPEARS entirely (no mirror needed)
  ContactResolver           317   ← splits; AddressBook half stays Swift
  HealthCheck               301
  Redaction                 211
  TextCoverage              200
  UnderstandingVoiceExemplars 166
```

Strip the vocabulary data (mechanical), `Contracts.swift` (deleted, not ported), and the
platform half of `ContactResolver`, and the **real algorithmic port is ~3,500–4,000 lines.**

That is three weeks with tests, not three months. Your instinct was right.

---

## 2. What actually makes it tractable: you have a golden output

This is the crux. Reimplementing calibrated logic is normally terrifying — tuned thresholds,
an evidence floor, a documented −0.07 correlation someone measured — because a subtle
behavioural change is invisible.

**You can make it verifiable.** You have:

- `mirror.db` — 97,137 real messages
- `digest_v2.json` — the known-good output, 420 relationships

So build a **differential harness first**: run Swift over the mirror, run TypeScript over the
same mirror, assert field-level equality across all 420 relationships. Port one module at a
time behind it. A drift of one `relationship_kind` fails the build.

That converts the port from "reimplement and hope" into "refactor with a test oracle," which
is why it is weeks and not months. **Do not start the port without this harness.**

---

## 3. What moving derivation to the cloud actually buys

### 3.1 It deletes an entire class of bug, better than codegen does

Today: a frozen JSON Schema, a zod mirror, and a Swift `Codable` mirror. Three definitions of
the same thing. That is what produced the `digest.v2` enum drift — `unknown` allowed by the
arbiter, missing from zod — 554 validation errors and a week gone.

Track A's codegen was designed to solve this. **Moving derivation to the cloud dissolves it
instead**: with no Swift digest producer, there is no third mirror and no `Contracts.swift`.
The Mac uploads message shards; the cloud owns every derived type in one language.

**Track A (~1 week) becomes largely unnecessary.** That is a direct offset against the port
cost.

### 3.2 Re-analysis without a client release

The §2.3-B problem from `DERIVED_VS_CONTENT.md`, solved. Improve promise extraction → re-run
over R2 shards → every user has it in hours. With Swift on the Mac it is a Sparkle release
plus adoption lag plus a re-sync.

This is the compounding one. It applies to *every* future improvement of the thing that is
your moat.

### 3.3 Server-side debugging and evals

"Boi got this wrong" becomes inspectable. You have the shards and the extractor in the same
place; you can replay a user's corpus against a candidate change and diff the understanding.

### 3.4 The iteration loop gets ~100× faster

Measured, this session:

```
swift test    365 tests    265 s
vitest        244 tests    2.4 s
```

Four and a half minutes versus two seconds. Over the months of extractor tuning that
`RELATIONSHIP_MODEL.md` implies, that difference is enormous — and it is felt on every single
change, by every agent working the code.

### 3.5 The Mac app gets much smaller

It becomes a capture agent: read `chat.db`, decode typedstream, resolve contacts, hold
permissions, upload shards, schedule wakes. `DigestBuilder`, `VoicePackBuilder`, `Metrics`,
`UnderstandingBuilder` all leave. Fewer releases, smaller TCC surface, less to sign and
notarize, less that can break on a macOS update.

---

## 4. The costs, honestly

| Cost | Assessment |
|---|---|
| ~3 weeks of porting | Real. Partly offset by dropping Track A. |
| Behavioural drift risk | **The serious one.** Mitigated by §2's harness; do not proceed without it. |
| Cloud compute for derivation | Must be **incremental** — process the delta, update rolling metrics. Full reprocessing of 97k messages per user per day does not scale. This is a design requirement, not an optimisation. |
| Slower first digest | Derivation happens after upload rather than during sync. It is a background job; nobody is watching. |
| No offline digest | Irrelevant — the digest is only ever consumed by the cloud. |
| TS is slower than Swift on hot loops | Fine at this scale, and Bun/Node handles 97k rows comfortably. |
| Privacy of on-device derivation | **Moot.** Content is uploading to R2 either way. |

---

## 5. Why now rather than after v3

Decisive argument: **`RELATIONSHIP_MODEL.md` adds a pile of new extraction logic** —
`open_loops`, `lifecycle_stage`, `expected_gap_days`, `relationship_edges`,
`relationship_events`.

Write those in Swift now and you write them **twice**. Decide now and every new extractor is
written once, in the language it will live in.

The same applies to the agent tools: building them against a Swift-derived digest and then
changing the producer means re-validating all of it.

---

## 6. Migration shape — strangler fig, with a comparison gate

`CONTENT_STORAGE.md` §4 warns against running both implementations, and that warning stands
for a *permanent* arrangement — silent drift there produces wrong understanding rather than a
loud 400. But a **transitional** dual-run with automated comparison is exactly how you make
the cutover safe. The distinction is that it is temporary and gated.

1. **Harness first.** Swift-vs-TS differential over the real mirror. Nothing else starts until
   this is green on the existing implementation compared to itself.
2. **Port bottom-up**: `TextCoverage` → `Redaction` → `FactVocabulary`/`FactExtractor` →
   `Metrics` → `UnderstandingBuilder` → `VoicePackBuilder` → `DigestBuilder`. Each lands only
   when the harness is byte-identical on all 420 relationships.
3. **Dual-run in production**, cloud derivation shadowing Swift, differences logged and
   alerted. Swift remains authoritative.
4. **Cut over** when divergence is zero for a week.
5. **Delete the Swift derivation modules.** Not before — this is the step that makes the
   dual-run temporary rather than permanent.

---

## 7. Recommendation

**Port. Start with the harness. Write all new extractors in TypeScript only.**

Net cost is roughly **3 weeks minus Track A's week**, against: one language for all product
logic, an entire bug class structurally eliminated, re-analysis for all users in hours,
server-side debugging, and a 100× faster test loop on the code you will be tuning for the
next year.

Two conditions I would not compromise on:

- **The differential harness ships before the first ported module.** Without it this is a
  rewrite of calibrated logic with no oracle, which is how you silently ship worse
  understanding and find out from users.
- **Incremental derivation is designed in from the start.** Reprocessing every user's full
  corpus on every sync is a wall you hit at ~10k users, and retrofitting incrementality into
  extractors that assume a full corpus is painful.

### What this changes in the build plan

- **Track A (codegen)** — shrinks to just the `chat_reply.v2` / `chat_route.v1` schemas. The
  Swift↔zod mirror problem disappears with `Contracts.swift`.
- **New Track I — derivation port.** Owned by **Claude** (calibrated logic, high judgment,
  needs the harness discipline). Blocks the new extractors.
- **Track E (DeepSeek)** — unchanged; the tables are the same wherever they are populated
  from.
- **`RELATIONSHIP_MODEL.md` extractors** — all written in TypeScript, after Track I's harness
  exists. Do not write them in Swift.
