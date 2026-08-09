# Session Prompt — DeepSeek v4 Pro in Cline (VSCode)

Paste this as your first message in a **fresh Cline session** with the workspace open at
`/Users/skylerluk/Dev/boi-imessage`.

Model policy: **DeepSeek v4 Pro** for all implementation. Switch to **v4 Flash** for the
mechanical passes explicitly marked ⚡ below (boilerplate, repetitive edits, doc updates) —
those are volume work where speed matters more than judgment.

---

## THE PROMPT

> You are building the data and delivery layers for the Boi v3 release. Read these first:
>
> 1. `V3_ARCHITECTURE.md` — the build spec. **§4.1 is the frozen database schema. Implement
>    it exactly as written.** §5 is the scale plan.
> 2. `RELATIONSHIP_MODEL.md` — why these tables exist.
> 3. `boi_remaining_work.md` — pre-existing test failures you must NOT try to fix.
>
> **A parallel Claude Code session is building Tracks A, B, C, D, and H in this same repo.**
> You own **Tracks E, F, and G only**, and you work them **sequentially in this order: E → F
> → G**. Do not start F until E's tests are green.
>
> **File ownership — never edit outside this list**:
> `cloud/db/**` · `cloud/channel/**` · `cloud/brief/**` · `mac/scripts/**` ·
> `mac/Package.swift` · `cloud/api/src/routes/ingest.ts`
>
> Files that are **off limits** (Claude owns them): `cloud/agent/**`, `cloud/chat/**`,
> `contracts/**`, `codegen/**`, `cloud/api/src/schemas.ts`, `cloud/api/src/differential.test.ts`,
> `mac/Sources/BoiKit/{FullDiskAccess,ContactResolver,Uploader,MessageReader}.swift`,
> `mac/Sources/BoiApp/**`.
>
> **Also off limits — `cloud/phase2-runtime/**` and `cloud/inbound/**`.** This is the
> currently-live chat path (`inbound-adapter.ts`, `router.ts`, `compose-runtime.ts`,
> `private-store.ts`, `turn-vault.ts`, `retention-worker.ts`). Track B is replacing it, and it
> **stays running until then** — it is what answers real messages today. Your Track F work
> touches delivery, which this path also uses, so be careful: change
> `cloud/channel/**` only, never the callers in `cloud/inbound/**`. If a delivery change would
> require editing a caller there, stop and log it in `INTERFACES.md` instead.
>
> **Read `INTERFACES.md` before starting each track and before touching any shared file.**
> It is how you learn what the Claude session changed. Append only — never rewrite or reorder
> existing entries.
>
> Shared files (`cloud/api/src/main.ts`, `cloud/shared/src/contracts.ts`,
> `mac/Sources/BoiKit/SyncRun.swift`): make the smallest possible edit, commit immediately,
> and append a line to `INTERFACES.md` describing the change.
>
> **Git discipline**: work in a git worktree on branch `v3/deepseek`. Open a **draft PR
> early** and push after every green test run. Commit sequentially and often — never more
> than ~45 minutes of uncommitted work. Attribute commits to
> `Skyler Luk <skylerluk@gmail.com>`.
>
> **Verification**: run `npx vitest run <the suites you touched>` after each change.
> `npx tsc -p tsconfig.json --noEmit` must stay clean. **These 10 failures are pre-existing —
> do not try to fix them**: `cloud/db/src/schema.test.ts` (6, needs a live Postgres),
> `cloud/e2e/src/e2e.test.ts` (4, card rendering), `cloud/phase2-runtime/inbound-adapter.test.ts`
> (fails to collect).
>
> Start with Track E, task E1. Report progress after each numbered task.

---

## Track E — Data layer (do this first, it unblocks everything)

**E1. Migrations for every table in `V3_ARCHITECTURE.md` §4.1.**
New files under `cloud/db/migrations/`, following the existing numbering and the `.down.sql`
convention.

> ⚠️ **Everything keys on `person_id`, NOT `contact_id`.** Read the callout at the top of
> §4.1 before writing a line of SQL. `contact_id` is an iMessage handle cluster; the roadmap
> adds Gmail, Calendar, Photos and call history, where the same human arrives through a
> different handle. Getting this wrong means rekeying every relationship table later.

Order matters — **`persons`, `identities`, and `interactions` first**, because everything else
references `persons`. Then `outcomes`, `memories`, `corrections`, `draft_edits`, `open_loops`,
`relationship_metrics_daily`, `relationship_edges`, `precomputed_answers`, plus the
`alter table relationships` additions.

For v3 there is exactly one source (`imessage`), so it is one identity per person and
behaviour matches today. The existing `contact_id` becomes an `identities` row with
`source='imessage'`.

**Critical**: every new user-scoped table must be hash-partitioned by `user_id` and cascade
on delete, exactly like the existing ones. `cloud/db/src/schema.test.ts` enumerates
user-scoped tables from the catalog and will fail if you get this wrong — study
`001_identity.sql` and `002_ingest.sql` first and copy their structure precisely.

**E2. Repository functions** in `cloud/db/src/repository.ts` — insert/query for each new
table, following the existing `scopedQuery` pattern. **Every query must be scoped by
`user_id`.** Never write an unscoped query; `findUserIdByHandle` is the only exception in the
codebase and it is documented as such.

**E3. Batch insert.** `upsertRelationships` (`repository.ts:519`) currently loops one INSERT
per contact — 420 sequential round-trips per sync. Replace with a single multi-row insert.
Keep the `where relationships.as_of <= excluded.as_of` guard.

**E4. Chat reads SQL, not JSONB.** ⭐ **Highest-value task in your whole scope.**
`latestDigest` returns a 1.2 MB JSONB payload and callers parse all 420 relationships in
memory for every question. The data is already normalized into the `relationships` table and
the read path ignores it. Add query functions that filter in SQL:

```
relationshipsWaitingOnMe(scope, limit)   -- last_exchange_shape='question_from_them'
                                          -- and open_thread is not null
                                          -- order by days_since_last_contact desc
relationshipsDrifting(scope, limit)      -- order by overdue_by_days desc
relationshipByDisplay(scope, display)
```

Leave `latestDigest` in place for now — Claude's session removes the callers.

**E5. Enqueue ingest — and the queue is the point.** Read `BACKEND_ARCHITECTURE.md` §2–§3.

`POST /v1/digest` currently runs the whole insert transaction inside the HTTP request. Accept
→ write a job row → return 202 → process in a worker. Keep the existing 202 contract and the
`first`/`firstSyncOffer` behaviour identical.

Build it as **one queue per workload class, not one shared queue**:
`interactive · ingest · derive · precompute · proactive · reanalysis`.

The reason is concrete: all six classes currently share one Fastify process and
`pg.Pool({max: 8})`. A re-analysis job would take the pool and **every user waiting on a reply
would time out.** Separate queues with separate depth, and separate connection pools per
consumer.

A Postgres-backed queue (`graphile-worker`, `pgmq`, or a plain `jobs` table with
`for update skip locked`) is fine to ~10k users. Do not add a broker yet — just make the
class separation real so swapping the transport later is an implementation detail.

**E6. Digest payloads → R2.** Store the payload blob in object storage; DB keeps metadata
plus the normalized rows. Gate behind an env flag so it can be rolled out safely.

---

**E7–E10 implement `CONTENT_STORAGE.md`. Read that document in full before starting E7.**
Full message content now goes to R2 alongside the derived digest. Keep the boundary strict:
**Postgres never stores message text; R2 never serves a structured query.**

**E7. R2 content upload.** Server-side ingest endpoint + storage layout exactly as
`CONTENT_STORAGE.md` §1.1:

```
users/{user_id}/messages/{YYYY-MM}.jsonl.zst     immutable monthly shards
users/{user_id}/manifest.json                    shard list + checksums + schema version
```

Monthly shards make sync incremental, re-analysis streamable, and deletion a prefix delete.
New env: `BOI_R2_BUCKET`, `BOI_R2_ACCOUNT_ID`, `BOI_R2_ACCESS_KEY_ID`,
`BOI_R2_SECRET_ACCESS_KEY`, `BOI_CONTENT_UPLOAD_ENABLED`. **Everything behind
`BOI_CONTENT_UPLOAD_ENABLED`, default off** — it is the kill switch for the first weeks.

**E8. Envelope encryption.** Shards are encrypted before upload with a **per-user data key
wrapped by the master key**. Do not invent a scheme — reuse the existing pattern:
`CONTACT_KEY_ENVELOPE_MASTER_KEY`, `createHandleEnvelopeKeyProvider`, `HandleVault`,
`TurnVault`. A bucket compromise without the KEK must yield ciphertext.

**E9. Deletion completeness.** ⭐⭐ **The most important task in your entire scope. Do not ship
E7 without it.**

`deleteUser` is currently ONE statement that cascades Postgres foreign keys and then
**verifies against the catalog that nothing survived**. R2 objects have no foreign key. Ship
uploads without this and `deleteUser` reports verified success while the user's entire message
history sits in a bucket — a confident lie about deletion, and a regulatory one.

Required, all four:
1. Delete the `users/{user_id}/` prefix as part of user deletion.
2. **Verify the prefix is empty afterward and throw if it is not.** Mirror the existing
   catalog verification; do not fire and forget.
3. A reconciliation job listing R2 prefixes with no matching `users` row (orphans from partial
   failures).
4. Extend the deletion test to cover R2 with a stub object store.

**E10. Mac-side chunked uploader.** Resumable multipart upload from Swift, matching E7's
layout: compress → encrypt → presigned multipart → complete → update manifest. Resume after
interruption without re-uploading finished shards; only the current month's shard is mutable.

*(E10 touches `mac/Sources/BoiKit/`. `Uploader.swift` is Claude's file — put the new uploader
in a NEW file, e.g. `ContentUploader.swift`, and log it in `INTERFACES.md`.)*

---

## Track F — Delivery & packaging

**F1. Typing indicator.** Fire on webhook receipt, **before** any routing or model call —
target <200 ms. `SpectrumChannel.capabilities()` already declares `typing: true`; wire the
actual send.

**F2. Multi-bubble progressive delivery.** ⭐ **Build this before F3/F4 — Track B is blocked
on it.**

Implement `openBubbleSink()` in `cloud/channel/src/progressive.ts` exactly to the signature
in `V3_ARCHITECTURE.md` §4.4. That section is the contract; the Claude session codes against
it and develops against a stub until yours lands. Ship this one early even if F1 isn't
finished.

`outbound.v1` already carries a `blocks` array and `blocksToParts` already splits it. What's
missing is delivering bubble one as soon as it exists rather than waiting for the whole
reply. iMessage cannot stream tokens but it can stream messages — the single biggest
perceived-latency win available.

Requirements from §4.4: `deliver()` preserves call order · partial delivery survives a later
throw · `end()` is idempotent · do **not** add a second idempotency mechanism, the existing
canonical-outcome claim in `InboundRouter` still wraps the turn.

**F3. Sparkle auto-update.** ⚡ Add the Sparkle framework, an EdDSA-signed appcast, and a
feed URL. Every fix currently requires a manual DMG, re-copy, and permission regrant.

**F4. Universal binary + `LSUIElement`.** ⚡ Build for `x86_64` **and** `arm64` (currently
arm64-only, which excludes every Intel Mac — exactly the "old Mac that stays plugged in"
this product wants). Make the app a menu-bar agent.

---

## Track G — Precompute cache

**G0. Create `cloud/shared/src/intents.ts` exactly as written in `V3_ARCHITECTURE.md` §4.2a.**
This is the one file you create outside your own directories. The Claude session **imports**
it and will not edit it. These strings are the `precomputed_answers.intent` keys and the
router's intent names simultaneously — a rename on either side is a silent, permanent cache
miss, which is why they are frozen. Do this first, commit it alone, and log it in
`INTERFACES.md` so the other session can pick it up.

**G1.** At the end of each sync, compute answers for each intent in `INTENTS` and write them
to `precomputed_answers`. Store as `{blocks:[...], evidence:[...]}` per §4.1. The `blocks`
shape must match what `openBubbleSink().deliver()` accepts (§4.4), so a cache hit and an
agent answer deliver through the identical path.

**G2.** A `getPrecomputedAnswer(scope, intent)` lookup for the cache-hit path. Target
**<800 ms end to end with no agent turn at all** — this is simultaneously the fastest and the
cheapest path in the product, and it only works if the precompute happens at sync time.

**G3.** ⚡ Invalidate on new digest ingest.

---

## Rules that matter

1. **Do not invent schema.** §4.1 is frozen and Claude's session is coding against it. If
   something there is genuinely wrong, write the problem into `INTERFACES.md` and implement
   it as specified anyway — do not silently improve it.
2. **Every query scoped by `user_id`.** No exceptions in your scope.
3. **Don't fix the 10 pre-existing failures.** They are environmental. Chasing them wastes
   your session.
4. **Commit after every green test run.** Many agents are moving in this repo; long-lived
   uncommitted work will be lost to a conflict.
5. **Stay in your files.** A merge conflict in `cloud/chat/` costs both sessions more than
   the change was worth.
6. When a task is ambiguous, pick the option most consistent with surrounding code, note the
   choice in the PR description, and keep moving. Do not stop to ask.
