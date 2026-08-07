# state.md — UnderstandingBuilder, five roots

**Worktree:** `/Users/skylerluk/Dev/boi-imessage-understanding`
**Branch:** `phase2-n-understanding-fix` (from `phase2-k-join` @ `79d5a88`)
**Nothing is committed.** All changes are uncommitted in the working tree, as requested.

Measured against the real corpus: 96,534 mirror rows, 417 relationships, 140 with ≥20
messages. Every number below is from an actual run, not an estimate.

---

## 1. Both distributions, before and after

The harness regenerates `digest.v2` from the real mirror against any checkout. It was
validated by reproducing the pre-change baseline exactly before it was used to measure
anything.

### relationship_kind

| | before (417) | before (≥20) | after (417) | after (≥20) |
|---|---|---|---|---|
| unknown | — | — | **267 (64.0%)** | **9 (6.4%)** |
| close_friend | 90 (21.6%) | 17 (12.1%) | 85 (20.4%) | 81 (57.9%) |
| dormant_close | 0 | 0 | 37 (8.9%) | 27 (19.3%) |
| work | 92 (22.1%) | 65 (46.4%) | 20 (4.8%) | 18 (12.9%) |
| family | 65 (15.6%) | 57 (40.7%) | 7 (1.7%) | 5 (3.6%) |
| logistics | 170 (40.8%) | 1 (0.7%) | 1 (0.2%) | 1 (0.8%) |

### register

| | before (417) | before (≥20) | after (417) | after (≥20) |
|---|---|---|---|---|
| unknown | — | — | **284 (68.1%)** | **7 (5.0%)** |
| casual | 183 (43.9%) | 125 (89.3%) | 66 (15.8%) | 66 (47.1%) |
| warm | 13 (3.1%) | 1 (0.7%) | 35 (8.4%) | 35 (25.0%) |
| formal | 16 (3.8%) | 4 (2.9%) | 29 (7.0%) | 29 (20.7%) |
| terse | 205 (49.2%) | 10 (7.1%) | 3 (0.7%) | 3 (2.1%) |

### last_exchange_shape

| | before (417) | before (≥20) | after (417) | after (≥20) |
|---|---|---|---|---|
| statement_from_them | 244 | 56 | 244 | 56 |
| statement_from_you | 133 | 70 | 133 | 70 |
| question_from_them | 38 | 13 | 33 | 11 |
| plan_unresolved | **2** | **1** | **7** | **3** |

`open_thread` is non-null on 40 of 417 and 14 of 140 in both runs — the population that
*has* an outstanding turn did not change, only what the field says about it.

---

## 2. Which signals replaced the token checks, and why each is not volume-correlated

The old classifier was:

```swift
if topics.contains("family") { return .family }   // fires on ONE token anywhere
if topics.contains("work")   { return .work }     // ditto
if userShare < 0.2 || > 0.8  { return .logistics } // always true of a 1-message thread
return .closeFriend                                // residual, never evidenced
```

Signals were selected by measuring Spearman rho against thread length **inside the
population the classifier actually sees** (≥20 messages — the all-threads column is
dominated by 106 one-message threads and is misleading).

| signal used | rho vs length | role |
|---|---|---|
| `userShare` → `balance` | **−0.07** | how evenly the two sides carry the thread |
| `weekendShare` | **+0.16** | off-hours sociality |
| `nightShare` | **+0.15** | off-hours sociality |
| `businessHoursShare` | **−0.11** | work shape |
| `maxGapDays` | **+0.02** | episodic history |
| `daysSinceLast` | −0.40 | **disclosed exception**, gate only — see below |
| topic **density** | rate by construction | contributes, never decides |

Every one of these is a **share or a rate** — a quantity divided by the thread's own size
— so it cannot grow merely because a thread is long. That is the whole mechanism: the old
`topics.contains(...)` was a *presence* test, and the probability a given word appears
somewhere rises toward 1 with length. Density (share of messages carrying a marker) is
the same evidence expressed as a rate, and it does not.

**Rejected despite being intuitive**, because measurement showed they are volume in
disguise: `active_days` (0.90), `sessions` (0.91), `burstiness` (0.67),
`profanity_rate` (0.66), `messages_per_active_day` (0.57), `lifespan_days` (0.52),
`median_gap_days` (−0.35). My first draft of the classifier used four of these; the
corpus survey is what removed them.

**The one disclosed exception.** `daysSinceLast` has rho −0.40 and is used *only* to gate
`dormant_close`. Dormancy and volume are genuinely anti-correlated in this corpus, so no
clean substitute exists; using anything else would mean the category cannot fire at all.
It is measured against the newest message **in the corpus**, not the wall clock, so
re-reading the same corpus tomorrow cannot silently reclassify anybody.

`logistics` is now positively evidenced (lopsided + business-hours + not off-hours)
rather than being the value thin threads fall into. `closeFriend` is positively scored
rather than being the residual.

---

## 3. Can `dormant_close` fire?

**Yes — 37 of 417, and 27 of 140 substantive. It fired 0 times before.**

The old gate was `typicalGapDays >= 30 && total >= 20`. It is not merely rare, it is
**structurally impossible**: across all 140 threads with ≥20 messages, the largest median
gap is **0.133 days (3.2 hours)**. Median gap and message count are mechanically
anti-correlated — any thread with enough messages to clear the volume half is by
construction burst-textual, so the cadence half can never also be true. Corpus-wide, 61%
of consecutive gaps are under 60 seconds.

Replaced with silence since the thread's last message (≥90 days), which splits the
substantive population roughly 29/71. `closeFriend` now carries a dormancy penalty,
because otherwise a fully dormant thread scores identically to `dormant_close` and the
two cancel into `unknown`.

---

## 4. Test and guard status

**`swift test --package-path mac`** — **zero regressions.** The failure set after the
change is byte-identical to the baseline taken on the unmodified `boi-imessage-track-k`
checkout: the same 6 tests, all environmental (unbuilt app bundle, an absent Python
fixture, two upload tests, typedstream fixtures), none of them touching this work.

```
AppBundleWakeHelperTests  testBuiltBundleEmbedsTheSignedHelperAndDedicatedDaemonPlist
DigestAmendment001Tests   testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus
LaunchAgentTests          testTheBuiltBundlesPlistPassesTheSameRules
SyncRunUploadTests        testAFullSyncUploadsTheDigestAndEveryVoicePack
SyncRunUploadTests        testDryRunUploadsNothingAndItsOutputCarriesTheByteCountAndNoBody
TypedStreamTests          testRealBlobsDecodeToTheStringAppleStoredInTheTextColumn
```

`swift test` is therefore **not green**, and was not green before this work either. I did
not fix the six; they are unrelated and outside scope. See §7/F2 for the one failure this
change *did* cause, now fixed and absent from the list above.

`UnderstandingBuilderTests`: **28/28 green** (was 13 tests).

**Python** — `intelligence/tests`: baseline 26 failed / 327 passed; after 26 failed /
**335** passed. Identical failure set (pre-existing, missing optional deps); the 8 new
tests all pass.

**Leak checker on the real output**, before vs after, byte-identical result:

```
FAIL -- 832 violation(s) across 2 field(s).
  relationship.facts                    -- 285 violation(s)
  understanding.voice_exemplars[].text  -- 547 violation(s)
```

**Zero in `understanding.open_thread`, before and after.** The 832 are pre-existing and
in fields this work did not touch (see flag F5). Exit code 1 is therefore pre-existing.

**Schema** — the regenerated 417-relationship document validates against the widened
`digest.v2` with **0 errors**; `scripts/validate_fixtures.py` still reports all 20
fixtures valid.

---

## 5. Every acceptance criterion, with the mutation that breaks it

Each mutation was applied to the source, rebuilt, re-measured against the real corpus,
and reverted. Full log: `scratchpad/mutate.py`, `mutate2.py`.

| criterion | unmutated | mutation | mutated |
|---|---|---|---|
| **C1** no category more than doubles its share | **GREEN** 1.09× (limit 2.00×) | evidence floor removed | **RED** 2.31× |
| | | topic presence instead of density | GREEN 1.10× — *survived* |
| | | raw message count replaces balance | GREEN 1.12× — *survived* |
| **C2** no register value >60% on ≥20 | **GREEN** casual 47.1% | absolute length histogram restored | **RED** casual 77.9% |
| **C3** canary cannot reach `open_thread` | **GREEN** 0 outside grammar | counterpart prose interpolated | **RED** 27 outside grammar |
| **C4** `plan_unresolved` rises materially | **GREEN** 7/417, 17.5% of outstanding turns | question tested before plan | **RED** 2/417, 5.0% |

C1 is evaluated on the **classified** population (excluding `unknown`) — see flag F4.

**C3's second half**, the leak checker exiting non-zero: proven directly. A real inbound
sentence planted into `open_thread` → exit 1 naming the field. The mutation that breaks
it is the pre-change checker: an inbound *fragment* wrapped in template text passes the
old code (exit 0) and fails the new structural grammar check (exit 1). Locked in as
`intelligence/tests/test_open_thread_leak.py`, 8 tests.

**C4's fixture**, verbatim from the prompt: `"want to grab dinner saturday?"` now
classifies as `plan_unresolved`, not `question_from_them`
(`testAPlanPhrasedAsAQuestionIsAnUnresolvedPlan`).

### C1 is weaker than the prompt claims — this is a real finding

C1 survived **two** mutations, including substituting a raw message count for the
balance signal. That is "keyed on volume" in the most literal possible sense, and the
criterion did not move.

The prompt's reasoning — *"a classifier whose output inverts under a volume filter is
keyed on volume"* — is true. The converse it is being used for is not: a classifier keyed
on volume need not invert under the filter. C1 catches the *thin-thread default* (the
original defect, RED at 2.31×) but it is not a general volume-keying detector.

What caught both survivors was `testLengtheningAThreadDoesNotChangeWhatItIs`: build a
thread, build a 20× longer one with identical proportions, assert the same classification.
**That test, not C1, is what pins the property.** Treat it as load-bearing.

---

## 6. What changed, by file

| file | why |
|---|---|
| `mac/Sources/BoiKit/UnderstandingBuilder.swift` | all five roots |
| `mac/Tests/BoiKitTests/UnderstandingBuilderTests.swift` | 13 → 28 tests |
| `contracts/schema/digest.v2.json` | `unknown` added to 3 enums; **no version bump** |
| `contracts/schema/voice_pack.v2.json` | `unknown` added to the exemplar register enum |
| `scripts/check_voice_pack_leak.py` | closed-grammar check for `open_thread`; categorised reporting |
| `intelligence/tests/test_open_thread_leak.py` | **new** — the regression test you asked for |
| `mac/Sources/BoiKit/Contracts.swift` | `unknown` on the two wire enums |
| `mac/Sources/BoiKit/DigestBuilder.swift` | 2 exhaustive switches |
| `mac/Sources/BoiKit/VoicePackBuilder.swift` | 1 exhaustive switch |

The last three are outside the prompt's stated allowlist and are **unavoidable**: adding a
case to `UnderstandingRegister` / `UnderstandingRelationshipKind` makes three `switch`
statements non-exhaustive, so the package does not compile without them. Each edit is a
single added `case`. Flagged rather than assumed.

---

## 7. Flags

**F1 — BLOCKER for upload. Three cloud validators will reject `unknown`.** Not changed
(outside scope), and the Swift will emit these values as soon as it runs:

- `cloud/api/src/schemas.ts` (lines ~179, 185, 186) — **Zod, runtime. This hard-fails
  ingest.**
- `cloud/chat/src/draft.ts` (7, 10) — `REGISTER`, `RELATIONSHIP_KIND` constants
- `cloud/shared/src/contracts.ts` (44, 48) — TS union types

Widening the Swift enum without these is a broken upload path. This needs a decision
before anything ships.

**F2 — the prompt's Root 1 recommends a signal this repo bans.** "reciprocity" is named
in the required-signals list, but CONTRACTS.md §6 bans it by name as *"the most legally
dangerous number in the category"*, and `DigestGuardTests.testNoSourceFileMentionsThe
BannedBalanceMetric` fails the build if it appears anywhere under `mac/`. I used a
`userShare`-derived balance instead — which also measures better here (rho −0.07 vs
+0.21). **That guard test is the one failure my change caused**, from the word appearing
in a comment explaining why I had *not* used it. Now fixed, and the comment rewritten to
warn the next person off without naming it.

**F3 — `unknown` and C1 are in tension in the prompt itself.** Root 1 requires returning
`unknown` below an evidence threshold; C1 requires no category to more than double its
share under a volume filter. An evidence floor is *by construction* a volume gate, so on
raw shares `unknown` goes 64.0% → 6.4% and every other category roughly triples. On
**classified** shares the worst ratio is 1.09×. I report the classified figure as the
criterion, because the alternative is that the two requirements cannot both be satisfied.
Raw numbers are in §1 so you can judge it yourself.

**F4 — the leak checker's report was hiding findings, and now isn't.** This is what your
first message caught. The `open_thread` check fired correctly (825 → 826) but printed
`problems[:10]`, all of which were `facts`, and exit was already 1 for unrelated reasons —
so a real leak was indistinguishable from a clean run. Findings are now grouped by field
with per-field counts and examples. **Categorising immediately exposed a whole field
nobody could see: 547 `voice_exemplars[].text` violations** that the flat truncated list
had never once displayed.

**F5 — those 832 violations are pre-existing and unrelated, but they are real.** 285
`facts` (short allowlist tokens like `'today'` that are also, verbatim, somebody's entire
message) and 547 `voice_exemplars` (`'?'`, `'W'`, `'💀'` — the exemplar check has no
minimum-length floor, unlike the facts span check, so any short user message that anyone
ever echoed back reads as a leak). Both look like the same false-positive class the
script's own docstring warns about. Not touched — out of scope, and the fix is a judgement
call about the length floor.

**F6 — `cadence_norm` is degenerate.** It reads `"recently active"` for **all 140**
substantive relationships, before and after, because it keys on `medianGapDays`, which is
~0 for every burst-textual thread. It is the same defect as the dead `dormant_close`
gate, in a field the prompt did not list. Left alone deliberately; a session-gap measure
would fix it.

**F7 — Root 3 pays off less than it looks.** Only 6 of 40 open threads picked up a
subject (`work` ×3, `apartment`, `school`, plus plan variants). The mechanism is correct
and the grammar is airtight, but the closed vocabulary has **6 tokens**, and an
outstanding turn is usually one short message. Widening `topicMarkers` is the follow-up
that makes this field earn its place — and it requires the matching vocabulary in
`check_voice_pack_leak.py`, which will fail loudly if you forget, by design.

**F8 — thresholds are tuned to one corpus.** `formalCut`, `terseCut`, `warmthFloor`, the
density normalisers and the dormancy floor were calibrated against this user's 417
relationships. They are fixed constants, not per-run percentiles, so a thread's reading
never changes because an unrelated thread changed — but they have only been seen on one
person's data. The register signals are all baseline-relative, which should port; the
time-of-day and dormancy constants are the ones most likely to need revisiting.

**F9 — the harness cannot read AddressBook or CallHistory.** A bare SwiftPM binary has no
Full Disk Access, so `address_book_records=-1` in every run. The pre-change baseline was
produced under the identical condition, so the before/after comparison is sound, but
absolute `contact_id`/`display` values differ from what the signed app produces.

---

## 8. Where things are

- Worktree: `/Users/skylerluk/Dev/boi-imessage-understanding` — **uncommitted**
- Scratchpad (harness, corpus survey, mutation runs, generated digests):
  `/private/tmp/claude-501/-Users-skylerluk-Desktop-Claude-Workspace/09e86e94-11b4-4d3e-853f-42c1db80d154/scratchpad`

Regenerate the measurement at any time:

```
scratchpad/run-harness.sh /Users/skylerluk/Dev/boi-imessage-understanding/mac out.json
python3 scratchpad/dist.py out.json
```

The generated `digest_v2.*.json` files contain real contact names and redacted user
message text. They are in the scratchpad deliberately and should stay there.
