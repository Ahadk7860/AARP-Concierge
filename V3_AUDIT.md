# Boi v3 — Full Audit

**Date**: 2026-08-10
**Scope**: All 9 tracks (A–G, H-join, I-derivation) across `main` @ `82acd24`
**Source**: `STATE_V2.md`, `INTERFACES.md`, `V3_ARCHITECTURE.md`, code on `v3/h-join`, `v3/i-derivation`

---

## 1. Ship-readiness by track

### Track A — Contracts ✅ Complete, high quality
54 files, +607/-3,136 lines. Added `ChatReplyV2` with `evidence` refs and `ChatRouteV1`. Bidirectional type equality between TS types and zod schemas at compile time — the two cannot drift.

### Track B — Agent core ✅ Complete, high quality
16 files, ~2,700 lines. Router (138 lines) on gemini-2.5-flash-lite, fails closed to `refuse`. Tool registry (408 lines), all 9 §4.2 tools. Verifier (457 lines) — the most important file in v3. Agent loop (263 lines). 92 tests across 7 files. 0% router misclassification, 0% verifier unsupported-claim leakage on evals. Four verifier defects found and fixed pre-merge.

### Track C — Search / ask_device ✅ Complete
WebSocket gateway from cloud to Mac, gateway auth. ask_device FTS answers in 1-2ms locally.

### Track D — Permissions ✅ Complete, one open item
7/7 on security-scoped bookmark spike on macOS 15.7.4. Open: Sparkle bookmark survival test (Track F owns signing).

### Tracks E/F/G (DeepSeek) ✅ Complete, merged to main
13 commits. R2 content storage, deletion completeness, Sparkle framework, universal binary, LSUIElement, precompute cache, ingest worker, composite PKs, job retries, R2 cipher, boot interlock. 28/31 schema tests pass. 4 rounds of review caught 2 blocking defects + 1 production bug before merge.

### Track H — Join branch ✅ Integration complete
39 commits ahead of main. Holds A, B, C, D merged and green. Zero cross-track merge conflicts.

### Track I — Derivation port ✅ Port complete, cutover blocked
78 files, +9,079/-2,929 lines. ~160 tests across 20+ files. 420-relationship differential harness. Blockers: timezone (6.7% reclassification), dual-run not started, global voice pack unported.

---

## 2. Alignment with the goal

"Best at relationships, cannot fabricate facts about people."

| Goal | Status |
|---|---|
| Agent with tools | ✅ Built |
| Post-generation verification | ✅ Verifier: 0% fabrication on evals |
| Derivation in the cloud | ✅ 9,079 lines, 420-rel harness |
| Can search message history | ✅ ask_device FTS |
| Multi-bubble delivery | ⚠️ Collapses to one |
| Messages access state on wire | ❌ Missing |
| Timezone-aware derivation | ❌ Blocks cutover |

---

## 3. Code quality — what is genuinely good

1. **Verifier design** (Track B). Every claim must appear in a tool result from this turn. One regenerate, then degrade. Right defense against LLM fabrication.
2. **Differential test harness** (Track I). TS derivation vs Swift output on 420 relationships bidirectionally.
3. **INTERFACES.md cross-session protocol**. Two AI sessions in parallel, no merge conflicts.
4. **DEEPSEEK_FIXES.md review discipline**. 4 rounds, each finding real issues.
5. **Schema test catalog design**. Enumerates from information_schema, not hardcoded lists.

---

## 4. Code quality — what is concerning

1. **Evals, not live traffic**. 0% fabrication is against curated eval set, not real traffic.
2. **Harness proves aggregates, not per-item correctness**. registerFor was wrong for the entire port and the differential stayed green.
3. **contact_handles deletion runs vacuously**. seedEveryReachableTable never inserts into it.
4. **Shared fixtures** (/tmp/boi-a). 6 worktrees sharing fixture databases.
5. **R2 encryption written but untestable**. No account, no bucket, no credentials.
6. **Multi-bubble delivery collapses**. Live channel path not wired for separate bubbles.

---

## 5. Top items missed or needing flagging

### ⚠️ 1. precompute.ts is dead code (Track G)
Exported from index.ts. Zero call sites. precomputed_answers table exists but nothing populates it. Either wire it or document the deferral.

### ⚠️ 2. repository-v3.ts has zero callers — v3 tables are never populated (Track E)
385 lines of repository functions (upsertPerson, insertInteractions, upsertOpenLoops, etc.). No route, worker, or agent calls them. The v3 normalized tables exist as empty schema. Track I derivation reads from these tables. **Severity: High.** Must be wired before derivation cutover.

### ⚠️ 3. Same off-by-one existed in 4 places, caught post-hoc
batch-params.test.ts written after the upsertRelationships bug. All 4 base=params.length sites in repository-v3.ts fixed (+1). But nothing ever called these with more than one row — the v3 pipeline was never end-to-end tested.

### ⚠️ 4. jobs table accumulates forever
No TTL, no cleanup of done/failed rows. Fine at <1k users, degrades at scale.

### ⚠️ 5. Ingest route dual-path fallback could race with worker
enqueue failure falls through to inline insertDigest. Pre-worker design. DuplicateDigestError catches it but the path should be simplified.

### ⚠️ 6. `first` flag in enqueued payload is dead data
Route sets it, worker ignores it and re-derives. Correct behavior (avoids TOCTOU) but misleading.

### ⚠️ 7. Multi-bubble delivery collapses to one message
Documented in STATE_V2. User-visible.

### ⚠️ 8. contact_handles deletion runs vacuously
seedEveryReachableTable never inserts into it since migration 012. Table has FK + cascade, so DELETE works — test coverage is incomplete.

### ⚠️ 9. Derivation harness hides per-item errors
registerFor was wrong for the entire port, differential stayed green. Per-item functions can be systematically wrong and invisible.

---

## 6. What was correctly caught and fixed

- Composite PKs on partitioned tables (BLOCKING 1)
- Missing ingest consumer (BLOCKING 2)
- upsertRelationships off-by-one (BLOCKING round 3)
- Duplicate digest test — production path uses generated_at
- jobs not partitioned — documented rationale
- R2 boot interlock
- stream_checkpoints in UNPARTITIONED set
- All 21 migrations have matching down migrations
- batch-params.test.ts catches base=params.length across 4 functions

---

## 7. What needs to happen before shippable

| # | Item | Priority |
|---|------|----------|
| 1 | Live end-to-end test — real model, real device | 🔴 Now |
| 2 | Merge v3/h-join → main | 🔴 Now |
| 3 | Set model IDs + enable BOI_AGENT_PATH_ENABLED | 🔴 Now |
| 4 | Wire repository-v3.ts into ingest pipeline (Audit #2) | 🟡 Before cutover |
| 5 | Wire or document precompute.ts (Audit #1) | 🟡 Before flag |
| 6 | Simplify ingest route fallback (Audit #5) | 🟢 Nice to have |
| 7 | Timezone work on Mac + derivation | 🟡 Before cutover |
| 8 | Dual-run and cutover | 🟡 After timezone |
| 9 | Sparkle bookmark survival test | 🟢 Track F |
| 10 | Wire messages_access_state | 🟢 Nice to have |

---

## 8. Verdict

**85% to shippable v3 behind a flag** is accurate. Components are built, tested, integrated. The remaining work is validation, not construction. Two items from this audit need attention before cutover: wire repository-v3.ts into the ingest pipeline, and wire or document precompute.ts.

**Merge v3/h-join now. Run the live test. Wire the v3 pipeline. Enable the flag.**
