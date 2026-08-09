# Derived Understanding vs. Full Content in the Cloud

> ## ⚠️ DECIDED — 2026-08-08: hybrid, content in R2
>
> Boi stores the full corpus in Cloudflare R2 **and** keeps normalized structured data in
> Postgres. **`CONTENT_STORAGE.md` is the implementation spec.**
>
> §7 below recommended derived-only. That recommendation is **superseded**. The tradeoffs it
> documents are now *accepted costs*, not open questions — keep reading it for that, and for
> §2.3, which lists exactly what the hybrid buys back.
>
> The three costs the hybrid does **not** erase, and which need active management:
> deletion completeness (`CONTENT_STORAGE.md` §2.1), breach severity (§2.2 — mitigated by
> envelope encryption, not eliminated), and the loss of the "your messages never leave your
> Mac" claim (§5 — a narrower, still-true claim replaces it).

**Original decision document.** Read for the tradeoffs — this choice shapes the data model,
the privacy claim, and the rate at which the core intelligence can improve.

**The two options**

- **Derived-only (Boi today)** — the Mac computes understanding and uploads 1.15 MB of
  metrics, derived descriptions, and the user's *own* redacted exemplars. Counterpart prose
  never leaves the device. Content questions are served by `ask_device` against the on-device
  FTS index.
- **Full content (Pally)** — the Mac exports message history to Cloudflare R2 via presigned
  multipart upload. The cloud holds the corpus and searches it server-side.

*Evidence for the Pally description is static analysis only: `history_export_start`,
`assistant_import_start`, `uploadId`, `presign`, `CompleteMultipartUpload`,
`X-Amz-Signature`, `r2.cloudflarestorage.com`. The app was never run. Treat specifics as
inferred, the direction as solid.*

---

## 1. The numbers (measured, one real account)

```
mirror.db  (full content)     43.9 MB      97,137 messages
digest_v2  (derived)           1.15 MB        420 relationships     38× smaller
voice exemplars                4,617        user-authored only, avg 11/relationship
relationships with 0 exemplars   164 of 420  (39%)
relationships with open_thread    37 of 420  ( 9%)
message_fts (on device)        FTS5, populated — query in 1–2 ms
```

Two of these matter more than the rest. **39% of relationships have no text at all** in the
derived digest — for those contacts the cloud holds numbers and nothing else. And **FTS is
already built and answers in single-digit milliseconds**, which is why the content gap is far
narrower than the size ratio suggests.

---

## 2. Feature-by-feature

### 2.1 Equal — or better — with derived understanding

| Capability | Why derived wins |
|---|---|
| "Who's waiting on me / drifting / overdue" | Precomputed and calibrated. A SQL query (~50 ms) against a corpus search + rerank + context stuffing. |
| Relationship classification, cadence, momentum | `UnderstandingBuilder` has tuned thresholds and evidence floors. An LLM inferring the same from a transcript is a guess with no floor. |
| Consistency of answers | Same numbers every time. RAG over content varies with retrieval. |
| Per-query cost | SQL vs. an embedding search plus a larger context window. Compounds at volume. |
| Hallucination surface | The agent is handed a number, not a pile of text to interpret. |
| Breach exposure | Metrics leak vs. everyone's conversations leak. |
| Regulatory weight | Derived metrics vs. content that can reveal health, politics, sexuality, religion. |

### 2.2 Degraded but workable

| Capability | Derived-only reality |
|---|---|
| **"What did Maya say about the trip?"** | ✅ **via `ask_device`** — FTS 2 ms + round trip ≈ 1.5 s. **Requires the Mac awake.** |
| Thematic search ("anything about the lease") | Needs on-device embeddings. Possible (`NLEmbedding`, or MLX ~90 MB) but you ship and maintain the model. |
| **Drafting a reply** ⚠️ | **The crux.** You have a ≤140-char *derived description* of what they asked; Pally has the sentence. Draft quality gap is direct and user-visible. |
| Voice matching | 4,617 exemplars, but **39% of contacts have zero** — those fall back to a global voice. |
| Summarise a thread | Only via `ask_device`, and only with the Mac awake. |

### 2.3 Genuinely impossible with derived-only

These are the ones to weigh seriously.

**A. Any content question when the Mac is off.** Asleep, closed, travelling, sold. Pally
answers; you say "I need your Mac awake." Mitigable with a derived searchable summary
(per-thread topics + date ranges, no prose) that answers *"you discussed the trip around
March 3"* and offers the quote later — but the quote itself waits.

**B. Re-analysis without a client release.** ⭐ *The most underrated item in this document.*
Improve promise extraction, and Pally re-runs a job over R2 — every user has it in hours. You
must ship a Mac update, wait for adoption, and wait for a re-sync. With Sparkle that's days
to weeks. **This is a compounding velocity gap on exactly the intelligence that is your
moat.** It does not lose data — the Mac keeps the full mirror and recomputes locally — but it
slows every improvement cycle.

**C. Server-side debugging and evals on real data.** A user says "Boi got this wrong" and you
cannot see the source text. Pally inspects the thread. You need opt-in diagnostic upload,
which is a smaller version of the same decision. **This is a real, ongoing quality tax.**

**D. Proactive server-initiated insight that needs content.** A 7am brief saying "Maya asked
about the lease and you haven't replied" requires either content in the cloud or a woken Mac
at 7am. Derived `open_loops` covers much of this — *if* the extractor is good.

**E. Multi-device / Mac-free future.** iPhone-only users, or a user who stops owning a Mac,
have no path. Pally's cloud corpus is device-independent. This forecloses a market segment.

**F. Attachments, images, links.** Not in the derived digest at all. Pally indexes them.

**G. Cross-thread synthesis at corpus scale.** "Summarise everything anyone told me about the
wedding" spans hundreds of threads. Feasible on-device but slower, and unavailable when the
Mac is off.

---

## 3. Cost

Not the deciding factor in either direction — worth stating so it stops being argued.

| | Derived-only | Full content |
|---|---|---|
| Storage @ 100k users | ~115 GB | ~4.4 TB ≈ **$66/mo** on R2, egress free |
| Embedding, one-time | none | ~$0.04/user at `text-embedding-3-small` rates |
| Per-question inference | small context, SQL results | larger context after retrieval |
| Upload bandwidth | 1.15 MB/sync | 43.9 MB initial, deltas after |

Storage is a rounding error. The recurring difference is **per-question context size**, which
favours derived and compounds with usage.

---

## 4. Legal and trust

Not legal advice — get counsel before publishing any claim.

The asymmetry that matters: **your user consented; their contacts did not.** Both designs
hold third-party personal data, so both are in scope for GDPR/CCPA. The difference is
quantity and sensitivity. Message content can reveal health, politics, sexuality, religion,
and immigration status — categories that carry heightened obligations in several
jurisdictions. Derived metrics largely do not.

Three practical consequences:

1. **Breach severity.** Metrics leaking is embarrassing. Conversations leaking is
   catastrophic and potentially existential.
2. **Compelled disclosure.** A subpoena to Pally can reach conversations. A subpoena to Boi
   reaches metrics. Users who care about this are a real, if narrow, segment.
3. **The claim is marketable.** "Your messages never leave your Mac" is a sentence a
   competitor holding a corpus cannot say. It is worth something *only if you say it loudly*
   and someone cares — an assumption to test, not assume.

---

## 5. Reversibility

**In code: easy, and waiting costs nothing.** The Mac keeps the complete `MirrorDatabase`
permanently. Content export is additive — a new upload path beside the digest, backfillable
from the mirror on any future day.

**In public: one-way.** "Your messages never leave your Mac" can be broken exactly once.
Reversing needs re-consent from every existing user and reads as betrayal regardless of
handling.

```
derived-only → full content   : cheap in code, expensive in trust
full content → derived-only   : impossible; you cannot un-ship the claim
```

Two further ratchets: agent tools written against a cloud content index are painful to
unwind, and holding conversations creates retention and disclosure duties that do not shrink
back.

---

## 6. The middle option (likely landing spot)

**Bounded export.** Store only the counterpart message currently being replied to, only while
that loop is open, deleted on reply.

For the measured account that is **37 messages instead of 43.9 MB.**

- Fixes §2.2's crux — drafting gets the actual sentence
- Partially addresses §2.3 A and D — the open loop is answerable with the Mac off
- Leaves §2.3 B, C, E, F, G unsolved
- The claim survives with an honest asterisk: *"Boi keeps only the message you're replying
  to, and deletes it once you have."*

A second, independent option worth taking regardless: **opt-in diagnostic upload** for §2.3 C.
A user reporting a bad answer can share that thread with one tap. Solves the quality-tax
problem for the cases that actually matter, with explicit per-incident consent.

---

## 7. Recommendation

**Ship derived-only. Build `ask_device` search. Revisit in 60 days with usage data.**

Reasoning:

1. `message_fts` already exists and answers in 2 ms. The killer feature — finding what someone
   said — works **today** without uploading anything. This is the fact that most changes the
   calculus, and it was not obvious until measured.
2. Derived-only is the only option that preserves the choice. Full content forecloses it
   permanently.
3. The costs are real but concentrated in **B** (re-analysis velocity) and **C** (debugging) —
   both of which slow you down internally rather than degrading the product users see today.
4. Nobody knows yet how often the Mac-asleep case actually bites. That data does not exist.
   Choosing now is guessing; choosing in 60 days is measuring.

**Instrument from day one** — this is what makes the 60-day review real rather than a
re-run of this argument:

- count `ask_device` calls that fail with `reason: "asleep"`
- count questions the agent declines for lack of content
- track draft edit-distance, split by whether an open-loop description was available
- log every "Boi got this wrong" where you could not diagnose without source text

**Revisit immediately, not in 60 days, if**: asleep-failures exceed ~15% of content questions,
or drafting emerges as the primary use case, or you decide to pursue iPhone-only users. Any
one of those flips the answer toward §6's bounded export — **not** toward full content, which
remains the option to avoid unless something forces it.
