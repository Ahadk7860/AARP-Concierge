# Hybrid Content Storage — R2 + Postgres

**Decision made**: Boi stores the full message corpus in Cloudflare R2 **and** keeps
normalized structured data in Postgres. This supersedes the derived-only recommendation in
`DERIVED_VS_CONTENT.md` §7; that document is retained for the tradeoffs it records, which
are now accepted costs rather than open questions.

---

## 1. Division of labour

| Store | Holds | Serves | Grain |
|---|---|---|---|
| **Postgres** | relationships, `open_loops`, metrics, edges, memories, outcomes, message **metadata** | every fast structured question (~50 ms) | one row per contact / loop / day |
| **R2** | full message corpus, immutable, encrypted | content retrieval, search, re-analysis, backfill | one compressed shard per user-month |
| **Search index** | inverted + optional vector index | "what did Maya say about the trip" | per user |
| **Mac** | `mirror.db`, `message_fts` | fast local search, offline, source of truth for sync | — |

The rule that keeps this clean:

> **Postgres never stores message text. R2 never serves a structured query.**

Message text in Postgres is what turns 43.9 MB/user into 4.4 TB of JSONB churn and an
autovacuum pager rotation. Structured queries against R2 mean fetching megabytes to count
rows. Keep the boundary strict.

### 1.1 R2 layout

```
users/{user_id}/messages/{YYYY-MM}.jsonl.zst      immutable monthly shards
users/{user_id}/attachments/{sha256}              content-addressed, optional
users/{user_id}/manifest.json                     shard list + checksums + schema version
```

Monthly shards give you three things at once: incremental sync uploads only new and current
shards, re-analysis streams every shard in order, and deletion is a single prefix delete.

Compressed `jsonl.zst` on iMessage text runs roughly 4–6×, so ~43.9 MB becomes **~8–10 MB per
user**. At 100k users that is **~1 TB ≈ $15/month** on R2 with free egress.

---

## 2. Three things that will bite

### 2.1 Deletion completeness ⚠️ this one is a correctness regression

`deleteUser` today is **one statement** that cascades through Postgres foreign keys and then
**verifies against the catalog that nothing survived**. `cloud/db/src/schema.test.ts` enforces
this. It is one of the genuinely strong properties of the current system.

**R2 objects have no foreign key.** Ship the upload path without touching deletion and
`deleteUser` will report verified success while the user's entire message history remains in
a bucket. That is a silent, confident lie about deletion — the worst possible failure in this
category, and now a regulatory one too.

Required:

1. Delete the `users/{user_id}/` prefix as part of user deletion.
2. **Verify the prefix is empty afterward** and fail loudly if it is not — mirror the catalog
   verification, don't just fire and forget.
3. A reconciliation job that finds R2 prefixes with no matching `users` row (orphans from
   partial failures) and reports them.
4. Extend the existing deletion test to cover R2, with a stub object store.

**This is not optional and it is not a follow-up.** It ships with the upload path.

### 2.2 Encryption — reuse what already exists

A bucket holding 100k people's conversations is a categorically different asset from one
holding metrics. You already have envelope-encryption infrastructure:
`CONTACT_KEY_ENVELOPE_MASTER_KEY`, `createHandleEnvelopeKeyProvider`, `HandleVault`,
`TurnVault`, `EncryptedPrivateStore`.

Apply the same pattern: a **per-user data key**, wrapped by the master key, shards encrypted
client-side before upload. A bucket compromise without the KEK yields ciphertext.

This meaningfully reduces the breach severity that made the derived-only case compelling —
it is the single highest-leverage mitigation available, and the code pattern is already in
the repo.

### 2.3 Vector search does not scale naively ⚠️ do the arithmetic before building

```
97,137 messages/user × 100,000 users        = 9.7 billion messages
1536-dim float32                            = 6 KB each
                                            = 58 TB of vectors
```

That is not a viable index. Tiering, in order of impact:

| Lever | Effect |
|---|---|
| **Keyword first, vectors as fallback** | most searches never touch the index — biggest win by far |
| Bounded window (last 18–24 months) | ~5× fewer vectors |
| Length threshold (skip "ok", "haha", reactions) | ~2–3× fewer |
| MRL truncation to 512 dims | 3× smaller |
| int8 quantization | 4× smaller |

Combined: **58 TB → roughly 1 TB**, and viable.

**Ship keyword-only first.** People searching their own messages usually remember a
distinctive word, and you already have proof the keyword path is fast: `message_fts` answers
in 1–2 ms on device. Add vectors when measured recall justifies the cost, not before.

---

## 3. Where search actually runs — staged

Do not build the 100k-user answer now. The switch points:

| Scale | Search implementation | Why it stops working |
|---|---|---|
| **now → ~1k users** | **`ask_device` FTS on the Mac**, R2 as durable backup + re-analysis source | fails only when the Mac is asleep |
| ~1k → ~10k | + Postgres FTS over a **recent window** (tsvector, text for last ~12 months only) | text in Postgres bloats past ~10k users |
| ~10k+ | dedicated index — per-user SQLite in R2 queried over HTTP range requests, or a managed vector/search service | — |

Starting with `ask_device` is not wasted work even though content is now in R2: it is the
lowest-latency path (2 ms vs a network hop), it works offline, and it degrades to the cloud
copy when the Mac is off. **The tool contract `search_messages()` in `V3_ARCHITECTURE.md`
§4.2 is storage-agnostic precisely so this can move without touching the agent.**

---

## 4. The derivation question this forces

With content in the cloud, on-device derivation no longer buys privacy — it buys latency and
offline capability. So: where should `UnderstandingBuilder` run?

| Option | Pros | Cons |
|---|---|---|
| **1. Keep Swift on the Mac** *(recommended now)* | zero rewrite, proven, calibrated, fast, works offline | improvements need a client release + re-sync |
| 2. Port to TypeScript, derive in cloud | re-analysis for all users in hours; one implementation | months of porting; discards 11k proven lines |
| 3. Both | fast path + cloud re-analysis | two implementations, guaranteed drift |

**Recommendation: option 1 now, with a documented path to 2.** The Swift code is proven and
porting is months you do not have. Accept the release-lag on improvements initially.

Explicitly avoid option 3 — duplicate extraction logic in two languages is precisely the class
of bug that cost a week on the `digest.v2` enum mirror, except drift here is silent and
produces *wrong understanding* rather than a 400.

If re-analysis velocity later becomes the binding constraint, port **one extractor at a
time**, using the frozen contracts as the spec and the Track A codegen as the safety net.

---

## 5. Consent

The upload is material and users must actively agree. Onboarding needs a plain sentence —
*"Boi stores a copy of your message history so it can search and improve"* — not a buried
policy line. Pair it with an in-product delete that exercises §2.1 end to end.

An honest, narrower claim is still available and worth keeping: **your history is encrypted
with a key tied to your account, and deleting your account deletes it.** That is a real
promise, and §2.1 and §2.2 are what make it true rather than marketing.

---

## 6. Build changes

Against `V3_ARCHITECTURE.md`:

- **Track E** (DeepSeek) grows: R2 upload with encryption, monthly shard layout, manifest,
  **deletion + verification**, orphan reconciliation.
- **Track C** (Claude) unchanged — `ask_device` remains the first search implementation, and
  gains an R2 fallback for the Mac-asleep case.
- **Track D** (Claude) unchanged.
- Mac gains a chunked, resumable multipart uploader — the same shape as Pally's
  `presign` → `CompleteMultipartUpload` flow.
- New env: `BOI_R2_BUCKET`, `BOI_R2_ACCOUNT_ID`, `BOI_R2_ACCESS_KEY_ID`,
  `BOI_R2_SECRET_ACCESS_KEY`, `BOI_CONTENT_UPLOAD_ENABLED`.

**Gate the upload behind `BOI_CONTENT_UPLOAD_ENABLED` from day one.** It lets you ship the
plumbing before the consent flow is finished, and it is the kill switch if something goes
wrong in the first weeks.
