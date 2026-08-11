# Boi v3 — Build State Report

**Updated**: 2026-08-11, after the second production deploy
**Audience**: an agent or engineer who has never seen this build
**Purpose**: what exists, what is proven, what is broken, what needs a human

Read `V3_ARCHITECTURE.md` §4 for frozen interfaces, `INTERFACES.md` for the cross-session log,
`V3_AUDIT.md` for an external audit. This file says where the work actually stands.

---

## 1. Headline

**v3 is deployed and running in production with the new agent path switched off.**

`main` @ `b8f181f`. Seven of eight branches merged. Deployed 2026-08-11 13:17. Migrations 017–022 applied to production
Postgres. The old v2 chat path still answers real messages and is untouched.

**The one thing that has never happened: the v3 agent has never answered a real question.**
`BOI_AGENT_PATH_ENABLED` is unset everywhere. Everything below is built and tested; the agent
half is unproven against live traffic.

---

## 2. Progress

| Goal | Status |
|---|---|
| Shippable v3 behind a flag | **~92%** |
| v3 complete, Swift derivation deleted | **~60%** |

Remaining for the first: confirm a sync populates the v3 tables, then flip the flag.
Remaining for the second: timezone input, dual-run, cutover. Weeks, not hours.

---

## 3. What is on `main`

| Area | State |
|---|---|
| Agent, router, verifier, 10 tools | Built. **118 tests green** |
| Device search (`ask_device`, FTS) | Built. Real-token auth. 1–2 ms on 97k messages |
| macOS permissions, setup UI, CI | Built. TCC spike passed 7/7 |
| Contracts (`chat_reply.v2`, heartbeat) | Built, differential-tested |
| v3 derivation pipeline | Built, **never run against a real digest** |
| E/F/G (DeepSeek) | Merged: migrations, R2, queue, ingest worker, precompute |
| Track I derivation port | On `v3/i-derivation`, **unmerged by design** |

---

## 4. Deployment reality

- **Deployed**: `main` as of 15:04 today. Healthcheck passed. Six migrations applied.
- **Production model**: `gemma-4-31b-it` via `BOI_LIVE_CHAT_MODEL` (the v2 path).
- **Set but unused**: `BOI_ROUTER_MODEL`, `BOI_AGENT_MODEL`, `BOI_AGENT_ESCALATION_MODEL` —
  all three IDs confirmed to exist on the endpoint. Read only when the flag is on.
- **Railway is not git-linked.** Deploys happen via `railway up`, never automatically on push.

---

## 5. Verified live, end to end

A real message went from the user's phone through Spectrum, to the cloud, and back:

> **"who should i follow up with"** → *"+19202659901 had an open question at the last sync…"*

That proves the delivery loop works. It also exposed two real defects — see §6.

---

## 6. Open defects

### ⚠️ 1. Contacts never granted — names show as phone numbers
**Fixed in code, needs an app rebuild + a grant.**

`ContactResolver` reads the AddressBook SQLite file directly. macOS only lists an app under
Privacy → Contacts once it asks through the Contacts framework, and the app had no
`NSContactsUsageDescription`. So Boi could never request it and every handle fell back to its
raw number.

Verified: **a process holding Full Disk Access still gets `authorization denied` on that file.**
Contacts is a separate TCC service; FDA does not cover it.

Now: real `CNContactStore.requestAccess`, usage description confirmed in the built bundle.

### ✅ 2. Voice-pack rejections — FIXED (was 14/sync)
The server's phone pattern required only 7 digits, so it rejected ISO dates (`2026-08-10`),
scores, order numbers and bare digit runs. Measured on 173 real packs: 14 rejected, every
violation a false positive.

Those packs could never upload — the Mac resends identical bytes and gets an identical 422
forever. The file justified its breadth with *"a false positive costs one rejected upload,
which the Mac retries after redacting properly."* **The Mac does not re-redact on retry.** That
repair step was never built, so the assumption behind the breadth did not hold.

Now requires ten digits. Real-pack rejections **14 → 1** (that one carries a genuine 11-digit
run). Verified it still catches `415-555-0142`, `+1 (415) 555-0142`, `4155550142`,
`+44 20 7946 0958` and clears dates/scores/order numbers.

**Residual risk accepted by the product owner**: a bare local 7-digit number with no area code
no longer trips THIS guard. Guard one (`Redaction.swift`) and guard three
(`check_voice_pack_leak.py`) still cover it.

### ⚠️ 3. `general` answers always route through degrade
`extractClaims` treats every capitalized word as a name claim, and `general` deliberately
grounds zero name claims. So "New York in August" trips on two proper nouns.

The user still gets the right text — a passthrough delivers `general`'s own answer verbatim
when every tool call in the turn is `general` — but `status` reads `degraded` in telemetry and
it costs an escalation round-trip. Documented in `verifier.ts`'s header.

### ⚠️ 4. No live/web data
`general` uses model knowledge only. There is no web search in this repo. It says so honestly
rather than inventing a temperature. Real-time answers are a separate build.

### ⚠️ 5. `precompute.ts` still has zero callers
`precomputed_answers` is never populated, so the `cache_hit` lane always misses. Falls through
to the agent, which is correct but wastes the fast path.

---

## 7. Bugs found and fixed (why the test counts understate the work)

- **Verifier, four defects.** The worst: any ordinary word in evidence prose could ground a
  fabricated person name — the word "trip" in a snippet made "Trip asked about the plan" verify
  as grounded. Found by an independent audit after the orchestrator's own review missed it.
- **`repository-v3.ts`, two bugs, both live on `main`.** An off-by-one fixed in one place and
  left in four others, plus `upsertOpenLoops` generating 9 placeholders for a 10-column INSERT
  — it could never insert a row. Both survived because **nothing ever called them with more
  than one row**.
- **Heartbeat rejection.** `additionalProperties: false` rejected the whole payload for one
  unknown field; every heartbeat from every device would have 400'd.
- **`swift test` POSTed to production.** Six unguarded `SyncRun` call sites resolved the real
  `.env`. Fixed with stub injection plus an XCTest process guard — whose first implementation
  was wrong and was caught by its own regression tests.
- **`interaction_id` keyed on `digest_id`.** Every sync mints a fresh `digest_id`, so the
  same "last contact" event got a new row on every sync and `on conflict do nothing` never
  fired. `interactions` would have grown by one row per relationship per sync forever, drifting
  every interaction count upward. Now keyed on `person_id + occurred_at`. The existing
  idempotency test re-used one `digest_id`, which is why it passed. Found by external audit.
- **The deploy blocker.** `Dockerfile:8` runs `npm run typecheck && tsc`; 8 errors in
  `inbound-adapter.test.ts` failed the build before `preDeployCommand` ever ran. That file had
  been on the "pre-existing, do not chase" list since the original handoff. **It was never
  benign — it was blocking every deploy.**

---

## 8. Known limits

**The differential harness proves aggregates, not per-item correctness.** `registerFor` was
wrong for the entire port and the 420-relationship differential stayed green, because
`threadRegister` averages many messages and dilutes one heart-only message to nothing. Six
Unicode divergence classes were found this way; assume more exist.

**Timezone blocks derivation cutover.** Swift reads `Calendar.current`; the cloud defaults to
UTC. Measured: **28 of 420 relationships (6.7%) reclassify.** The `users` table has a
`timezone` column; the Mac does not send it and derivation does not use it.

**`lifecycle_stage` and `relationship_kind` have no v3 column.** `PostgresAgentStore` returns
null rather than inventing them.

**Local Postgres is shared across worktrees.** Local DB numbers are unreliable; trust CI, which
uses a clean container.

---

## 9. What needs a human

1. **Install the rebuilt app**, then grant Contacts. Fixes phone-numbers-instead-of-names.
2. ~~Decide the redaction question~~ — **done**, Option A, see §6.2.
3. **Confirm a sync populates the v3 tables**, then flip `BOI_AGENT_PATH_ENABLED`.
   **Do not flip it before that** — the agent would read empty tables and degrade on every
   relationship question, which is worse than the v2 path that works today.
4. **Delete the old chat path** — last step, only after the agent proves itself.
5. **Timezone work**, before derivation cutover.
6. **Sparkle bookmark survival test** on a signed build.

---

## 10. Standing rules

- Never delete the old chat path until a live test proves the new one.
- `BOI_AGENT_PATH_ENABLED` stays unset outside tests.
- One `swift test` at a time across all worktrees (`/tmp/boi-a` fixtures are shared).
- Never commit real message data.
- **Verify, do not assert** — every number from a command actually run.
- Do not weaken the verifier to make a test pass.

---

## 11. The honest risk

Every number here comes from tests against fakes, stubs and fixtures, plus one real v2
round trip. **The v3 agent has never answered a real question.** Expect the first live run to
find real problems. That is why the old path still exists, and why the flag is still off.
