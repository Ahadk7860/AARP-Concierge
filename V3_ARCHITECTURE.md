# Boi v3 — Full Architecture

**Status**: approved for build. This document is the single source of truth for both build
sessions. Supersedes the earlier v3 draft.

### Document map — read in this order

| Doc | What it decides |
|---|---|
| **this file** | the build spec. §4 = frozen interfaces |
| `CONTENT_STORAGE.md` | **DECIDED**: full corpus → R2 + Postgres hybrid. Deletion & encryption rules. |
| `LANGUAGE_DECISION.md` | **DECIDED**: derivation ports Swift → TypeScript (Track I) |
| `VISION_MULTI_SOURCE.md` | **DECIDED**: person/identity/interaction model; Gmail → Calendar/Photos roadmap |
| `BACKEND_ARCHITECTURE.md` | six workload classes, queues, scale switch points |
| `RELATIONSHIP_MODEL.md` | why the relationship tables look like this |
| `AGENT_ARCHITECTURE.md` | why agent + verifier beats templating; search design |
| `STRATEGY_VS_PALLY.md` · `COMPETITOR_PALLY.md` · `DERIVED_VS_CONTENT.md` | competitive position and accepted costs |

### Decisions since the first draft

1. **Content → R2.** Full message corpus stored, encrypted, monthly shards. Deletion must
   verifiably reach R2 or `deleteUser` lies.
2. **Derivation → TypeScript.** Multi-source makes two implementations of "what a
   relationship is" untenable. New Track I. Track A shrinks.
3. **person_id, not contact_id.** One extra join now; a rekey of everything later.
4. **Six workload classes get separate queues and pools.** A re-analysis job must never
   starve a user waiting on a reply.
5. **Roadmap**: Gmail → Calendar/Photos → call history. **Slack is cut** from the consumer
   product — work-tool norms drag positioning into a crowded space.

---

## 1. What we are building

Boi becomes a **fluid conversational assistant** that is best-in-class at relationships and
at searching your own message history, and that **cannot fabricate facts about people**.

Three changes from today:

1. **The 900-line closed-vocabulary chat head is replaced by an agent with tools.** Fluid
   prose, any question, conversational.
2. **Grounding moves from generation-time templating to post-generation verification.** Same
   guarantee, no restriction on phrasing.
3. **The relationship model deepens** — open loops, lifecycle, trajectories, social graph —
   and the system starts recording outcomes, which is the only asset competitors cannot
   backfill.

**What is and isn't rewritten** (revised — see `LANGUAGE_DECISION.md`): the *platform* half of
`mac/Sources/BoiKit` (5,890 lines — `chat.db`, typedstream, TCC, wake, mirror, upload) stays
Swift permanently and barely changes. The *derivation* half (~3,500–4,000 lines of real logic
after stripping vocabulary data and `Contracts.swift`) ports to TypeScript in the cloud under
Track I, **behind a differential harness that proves byte-equality on the real 420-relationship
digest.** The Mac becomes a capture agent — one `SourceAdapter` among several.

---

## 2. Runtime shape

```
inbound iMessage (Spectrum webhook / stream)
        │
        ├─► typing indicator fired immediately (<200ms, before any model call)
        │
        ▼
   ROUTER  — Gemini 2.5 Flash Lite, sees question text ONLY
   returns: cache_hit | agent | refuse
        │
        ├── cache_hit ──► precomputed answer table ──────────────► deliver (<800ms)
        │
        ├── refuse ─────► fixed decline string ─────────────────► deliver
        │
        └── agent
              │
              ▼
        AGENT LOOP — Gemini 2.5 Flash Lite (escalates to Pro on tool-failure retry)
              │  tools:
              │   relationship_*  → SQL over normalized tables      ~50ms
              │   search_messages → ask_device → Mac FTS/embeddings ~1.5s
              │   memory_*        → SQL                             ~50ms
              │   general         → model knowledge / web           ~1s
              │   draft_message   → composes, never sends
              │   send_message    → REQUIRES explicit user approval
              │
              ▼
        VERIFIER — every factual claim about a person must map to a
                   tool result from THIS turn. Violation → one regenerate
                   with the violation named → then degrade to a grounded summary.
              │
              ▼
        MULTI-BUBBLE DELIVERY — first bubble ASAP, remainder as ready
              │
              ▼
        OUTCOME LEDGER — record what was suggested and what followed
```

### 2.1 Invariants (each is a test, not a guideline)

- **I1** The verifier runs on every agent reply. No path bypasses it.
- **I2** Any person-name, handle, date, or number in the output must appear in a tool result
  from this turn. Otherwise it is unsupported.
- **I3** Uncertainty routes to `refuse`, never to a confident answer.
- **I4** `send_message` never fires without explicit in-conversation approval.
- **I5** Counterpart prose is never persisted server-side. Search snippets transit encrypted
  and live only in the existing encrypted turn store.
- **I6** Every extractor (`open_loops`, `events`) carries an evidence floor and emits
  `unknown` below it — the `relationship_kind` discipline, applied everywhere.

---

## 3. Models

All via the existing OpenAI-compatible Gemini endpoint (`liveModelConfigFromEnv`).

```
BOI_ROUTER_MODEL=gemini-2.5-flash-lite     # router: fast, cheap, high volume
BOI_AGENT_MODEL=gemini-2.5-flash-lite      # main agent loop
BOI_AGENT_ESCALATION_MODEL=gemini-2.5-pro  # retry after verifier rejection
BOI_LIVE_CHAT_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

Separate env vars even at identical values — different latency budgets, different blast
radii. **Confirm exact model ids against the endpoint before wiring; do not trust these
strings blindly.**

---

## 4. FROZEN INTERFACES

**These are contracts. Both build sessions code against them in parallel. Changing one
requires updating this document first and notifying the other session.**

### 4.1 Database schema (owner: DeepSeek / Track E)

> ### ⚠️ KEY ON `person_id`, NOT `contact_id`
>
> `contact_id` is an **iMessage handle cluster**. The roadmap (`VISION_MULTI_SOURCE.md`) adds
> Gmail, Calendar, Photos and call history — where the same human arrives through a different
> handle. A person-centric key costs **one extra join today** and saves **a rekey of every
> relationship table later**.
>
> For v3, iMessage is the only source: one identity per person, behaviour identical to today.

```sql
-- ============ IDENTITY (create these FIRST — everything references persons) ============

create table persons (
  user_id    text not null references users(user_id) on delete cascade,
  person_id  text not null,          -- 'p_' + salted hash, same discipline as h_
  display    text not null,
  created_at timestamptz not null default now()
);

create table identities (
  user_id     text not null references users(user_id) on delete cascade,
  identity_id text not null,
  person_id   text not null,
  source      text not null,   -- 'imessage'|'gmail'|'calendar'|'photos'|'calls'
  handle      text not null,   -- normalized, salted-hashed exactly like contact_id today
  confidence  text not null,   -- 'exact'|'inferred'|'unknown'   (invariant I6)
  merged_by   text,            -- 'addressbook'|'email_match'|'user_confirmed'
  as_of       timestamptz not null,
  primary key (user_id, identity_id),
  unique (user_id, source, handle)
);
-- The existing iMessage contact_id becomes an identities row with source='imessage'.
-- MERGE RULES: exact signals only (AddressBook record id, identical email) merge
-- automatically. Name+company is 'inferred' and NEVER auto-merges. Name similarity alone
-- never merges. Under-merging understates one relationship; over-merging puts one person's
-- messages in another person's row.

-- Source-agnostic unit of evidence. Replaces "message" everywhere downstream.
create table interactions (
  user_id        text not null references users(user_id) on delete cascade,
  interaction_id text not null,
  person_id      text not null,
  source         text not null,
  direction      text not null,   -- 'from_me'|'to_me'
  occurred_at    timestamptz not null,
  thread_ref     text,
  content_ref    text,            -- pointer into R2. NEVER the content itself.
  length         int,
  meta           jsonb not null default '{}',
  primary key (user_id, interaction_id)
);

-- ============ MOAT TABLES (highest priority — unbackfillable signal) ============

create table outcomes (
  user_id      text not null references users(user_id) on delete cascade,
  outcome_id   text not null,
  kind         text not null,            -- 'nudge' | 'draft' | 'surfaced_loop' | 'answer'
  person_id    text,
  suggested_at timestamptz not null default now(),
  payload      jsonb not null,           -- what we suggested
  result       text,                     -- 'sent_verbatim'|'edited'|'ignored'|'dismissed'
  result_at    timestamptz,
  they_replied boolean,
  meta         jsonb not null default '{}',
  primary key (user_id, outcome_id)
);

create table memories (
  user_id    text not null references users(user_id) on delete cascade,
  memory_id  text not null,
  person_id  text,                         -- null = global
  text       text not null,               -- user-authored fact
  source     text not null,               -- 'user_stated' | 'user_corrected'
  created_at timestamptz not null default now(),
  active     boolean not null default true,
  primary key (user_id, memory_id)
);

create table corrections (
  user_id     text not null references users(user_id) on delete cascade,
  correction_id text not null,
  turn_id     text,
  claim       text not null,
  correction  text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, correction_id)
);

create table draft_edits (
  user_id    text not null references users(user_id) on delete cascade,
  edit_id    text not null,
  person_id  text,
  drafted    text not null,
  sent       text,
  created_at timestamptz not null default now(),
  primary key (user_id, edit_id)
);

-- ============ RELATIONSHIP DEPTH ============

create table open_loops (
  user_id     text not null references users(user_id) on delete cascade,
  loop_id     text not null,
  person_id   text not null,
  kind        text not null,   -- 'question'|'promise'|'plan'|'favor'|'decision'
  direction   text not null,   -- 'i_owe_them'|'they_owe_me'
  description text not null,   -- DERIVED, never a quote, <=140 chars
  opened_at   timestamptz not null,
  status      text not null default 'open',  -- 'open'|'resolved'|'abandoned'
  confidence  text not null,   -- 'high'|'medium'|'unknown'  (I6)
  as_of       timestamptz not null,
  primary key (user_id, loop_id)
);

create table relationship_metrics_daily (
  user_id    text not null references users(user_id) on delete cascade,
  person_id  text not null,
  day        date not null,
  message_count int not null,
  momentum   double precision,
  initiation_ratio double precision,
  median_gap_days double precision,
  response_latency_me_min  double precision,
  response_latency_them_min double precision,
  register   text,
  primary key (user_id, person_id, day)
);
-- WRITE ONLY ON MATERIAL CHANGE. Most relationships are unchanged most days.

create table relationship_edges (
  user_id     text not null references users(user_id) on delete cascade,
  person_a    text not null,
  person_b    text not null,
  shared_groups int not null default 0,
  co_mentions   int not null default 0,
  tie_strength  double precision,
  as_of       timestamptz not null,
  primary key (user_id, person_a, person_b)
);

-- ============ ADDITIONS TO EXISTING `relationships` ============
alter table relationships add column lifecycle_stage text;      -- new|building|steady|cooling|dormant|rekindled
alter table relationships add column tie_context text;          -- work|school|family|social|service
alter table relationships add column expected_gap_days double precision;
alter table relationships add column overdue_by_days double precision;
alter table relationships add column response_latency_me_min double precision;
alter table relationships add column response_latency_them_min double precision;
alter table relationships add column importance text;

-- ============ CACHE-FIRST ============
create table precomputed_answers (
  user_id     text not null references users(user_id) on delete cascade,
  intent      text not null,   -- 'waiting_on_me'|'drifting'|'overdue'|'morning_brief'
  answer      jsonb not null,  -- {blocks:[...], evidence:[...]}
  computed_at timestamptz not null default now(),
  primary key (user_id, intent)
);
```

All new tables follow the existing hash-partition-by-`user_id` and cascade-delete discipline.
Exception: `jobs` is unpartitioned — workers must poll across all users, and a
hash-partition would force a full partition scan on every dequeue. The `on delete
cascade` FK to `users` ensures cleanup on account deletion; see migration 021.
**Verify against `cloud/db/src/catalog.ts` + `schema.test.ts` — those tests enumerate
user-scoped tables and will fail if a new table is not partitioned/cascading correctly.**

### 4.2 Agent tool contracts (owner: Claude / Track B, C)

Storage-agnostic by design — the implementation may move from device to cloud later without
touching the agent.

```ts
search_messages({ query: string, who?: string, when?: string, limit?: number })
  -> { results: Array<{ person_id, display, when: string, snippet: string, thread_id: string }>,
       source: "device" | "cache", degraded?: string }

relationship_state({ person_id?: string, display?: string })
  -> { person_id, display, lifecycle_stage, expected_gap_days, overdue_by_days,
       momentum, initiation_ratio, register, relationship_kind, last_contact: string }

open_loops({ direction?: "i_owe_them"|"they_owe_me", kind?: string, limit?: number })
  -> { loops: Array<{ loop_id, person_id, display, kind, direction, description, age_days }> }

drifting({ limit?: number })
  -> { relationships: Array<{ person_id, display, overdue_by_days, expected_gap_days }> }

circle({ person_id: string })
  -> { connections: Array<{ person_id, display, shared_groups, tie_strength }> }

memory_write({ text: string, person_id?: string })  -> { memory_id }
memory_search({ query: string })                      -> { memories: [...] }

draft_message({ person_id: string, intent: string })
  -> { draft: string, based_on: Array<evidence_ref> }

general({ query: string })
  -> { answer: string, source: "model_knowledge", degraded?: "unavailable"|"empty_response" }
  // §2's "general → model knowledge / web" row — implemented 2026-08-10 (Track B). Model
  // knowledge ONLY: no web-search capability exists in this repo. Evidence source is the
  // distinct string "general", never a person-scoped source — the verifier (§4.2's own
  // guarantee, I2) deliberately excludes this tool from grounding any person-name or handle
  // claim (see INTERFACES.md's 2026-08-10 entry and verifier.ts's header for the residual
  // risk this creates for ordinary proper-noun-bearing world facts).

send_message({ person_id: string, text: string, approval_token: string })
  -> { sent: boolean }        // approval_token REQUIRED (I4)
```

Every tool returns an `evidence` array of `{ source, id }` refs. **The verifier consumes
these. A tool that returns no evidence refs cannot support any claim.**

### 4.2a FROZEN INTENT KEYS

These strings are shared between the router (Track B), the precompute cache (Track G), and
the `precomputed_answers.intent` column. **They are frozen. Neither session may rename,
add, or remove one without editing this section and logging it in `INTERFACES.md`.**

```ts
// cloud/shared/src/intents.ts  — created by Track G, imported by Track B
export const INTENTS = [
  "waiting_on_me",   // who is waiting on a reply from me
  "drifting",        // relationships past their expected gap
  "overdue",         // open loops aged past threshold
  "morning_brief",   // the daily summary
] as const;
export type Intent = typeof INTENTS[number];
```

A router intent with no matching `precomputed_answers` row falls through to the agent — a
cache miss is never an error. But a **renamed** key is a silent permanent cache miss, which
is why these are frozen rather than conventional.

`cloud/shared/src/intents.ts` is the one file Track G creates outside its own directory.
Track B imports it; Track B does not edit it.

### 4.3 `ask_device` protocol (owner: Claude / Track C)

Cloud → Mac over the persistent WebSocket:

```ts
// request
{ v: 1, id: string, op: "search", query: string,
  who?: string, when_from?: string, when_to?: string, limit: number }

// response
{ v: 1, id: string, ok: true,
  results: Array<{ person_id, when, snippet, thread_id, score }> }
// or
{ v: 1, id: string, ok: false, reason: "asleep"|"timeout"|"no_grant" }
```

Mac side searches `message_fts` (already exists, 97k messages, **1–2 ms**), filters by
`handle`/`sent_at`, returns snippets. Timeout 4s → agent degrades honestly.

### 4.4 Outbound delivery + the multi-bubble handshake (owner: DeepSeek / Track F)

`outbound.v1` already carries a `blocks` array and `blocksToParts` already splits it. The
typing indicator fires on webhook receipt, before routing.

**Progressive delivery needs an explicit handshake, because Track F owns delivery and Track B
owns the agent that produces the bubbles.** Without one, "send the first bubble ASAP" is
unimplementable — F cannot know when a bubble is ready.

**Track F builds this primitive first, as a plain function. Track B calls it.**

```ts
// cloud/channel/src/progressive.ts   — Track F owns this file
export type BubbleSink = {
  /** Deliver one bubble now. Safe to call repeatedly; ordering is preserved. */
  deliver(block: { type: "text"; text: string }): Promise<void>;
  /** No more bubbles. Flushes and closes the idempotency claim. */
  end(): Promise<void>;
};

export function openBubbleSink(input: {
  scope: UserScope;
  channel: Channel;
  idempotency_key: string;
  reply_to_message_id: string | null;
}): BubbleSink;
```

Contract both sides rely on:

- `deliver()` preserves call order; F handles batching and rate limits internally.
- Calling `deliver()` then throwing is safe — whatever was delivered stays delivered.
- `end()` is idempotent.
- The **existing** canonical-outcome claim in `InboundRouter` still wraps the whole turn;
  the sink does not introduce a second idempotency mechanism.

Track B's agent calls `deliver()` as each bubble finalises and `end()` when the verifier has
passed the final claim. **Bubbles are delivered only after the verifier clears them** — never
stream unverified prose to the user.

Until F lands, Track B may develop against a trivial in-memory `BubbleSink` stub that
collects blocks and sends once.

---

## 4.5 Content storage — R2 (decided)

Full message content is stored in Cloudflare R2 alongside the derived digest.
**`CONTENT_STORAGE.md` is the spec** — read it before implementing anything in this area.

The boundary that keeps the hybrid coherent:

> **Postgres never stores message text. R2 never serves a structured query.**

- Postgres: relationships, `open_loops`, metrics, edges, memories, outcomes, message
  *metadata* — every fast structured question, ~50 ms.
- R2: `users/{user_id}/messages/{YYYY-MM}.jsonl.zst`, encrypted, immutable monthly shards —
  content retrieval, re-analysis, backfill. ~8–10 MB/user compressed.
- `search_messages()` (§4.2) stays **storage-agnostic**: device FTS first (2 ms, offline),
  R2/cloud index as fallback when the Mac is asleep. The implementation moves without the
  agent noticing.

Three non-negotiables from `CONTENT_STORAGE.md`:

1. **Deletion must reach R2 and verify it.** `deleteUser` cascades Postgres FKs and verifies
   via the catalog; R2 has no FK. Shipping uploads without extending deletion makes
   `deleteUser` report verified success while the corpus survives.
2. **Envelope encryption**, reusing `CONTACT_KEY_ENVELOPE_MASTER_KEY` / `HandleVault` /
   `TurnVault` — per-user data key wrapped by the master key.
3. **Keyword search first.** Naive vectors over 9.7 B messages at 100k users is ~58 TB. See
   `CONTENT_STORAGE.md` §2.3 for the tiering that makes it ~1 TB, and ship without it.

**Superseded.** An earlier draft of this section said derivation stays in Swift and must not be
duplicated in TypeScript. `LANGUAGE_DECISION.md` and §6 supersede that: derivation ports to
TypeScript under Track I, behind a differential harness that proves parity against the real
420-relationship digest. Nine modules are ported and differentially green.

The concern behind the old wording was right and still governs the work: two implementations of
"what a relationship is" drift silently, and wrong understanding is worse than a loud 400. The
answer is not to avoid the port — multi-source makes a Swift-only derivation impossible, since
the Mac cannot derive Gmail relationships — but to keep exactly one implementation authoritative
at a time. Swift stays authoritative until dual-run shows zero divergence, then the Swift
derivation modules and `Contracts.swift` are **deleted**. A permanent dual-run would be the drift
bug again, except silent.

Two things gate cutover, both recorded in `INTERFACES.md`: the user's IANA timezone must reach
the cloud (Swift reads `Calendar.current`; without it ~7% of relationships reclassify), and the
differential harness only proves aggregates — a per-item function can be wrong and stay hidden.

---

## 5. Scale targets

| Trigger | Change | Track |
|---|---|---|
| now | batch multi-row insert replaces per-contact loop (`repository.ts:519`) | E |
| now | chat reads normalized SQL, **never** the 1.2 MB JSONB payload | E |
| ~1k users | ingest accepted → enqueued → worker, not in the request | E |
| ~5k users | digest payloads → R2, DB keeps metadata + normalized rows | E |
| ~10k users | read replicas; per-user inference budgets | later |
| ~50k users | physical shard by `user_id` (hash partitions already in place) | later |

Latency budget: typing <200 ms · cache hit <800 ms · agent turn <2.5 s · device search <5 s.

---

## 6. Work graph

Interfaces in §4 are frozen, so these run in parallel. Edges are hard dependencies only.

```
   A. Contracts & codegen ──┐
                            ├──► H. Integration & e2e
   B. Agent core ───────────┤
   C. Search / ask_device ──┤
   D. macOS permissions ────┤
   E. Data layer ───────────┤
   F. Delivery & packaging ─┤
   G. Precompute cache ─────┘

   E ⟶ G   (G reads tables E creates)
   C ⟶ B   (B's search tool calls C's protocol; both code against §4.2/§4.3)
   all ⟶ H
```

| Track | Owner | Scope |
|---|---|---|
| A | Claude | **Shrunk** — only `chat_reply.v2` + `chat_route.v1` schemas and their differential tests. The Swift↔zod mirror problem disappears with `Contracts.swift` under Track I. |
| B | Claude | Router, agent loop, tool registry, **verifier**, evals, Gemini wiring |
| C | Claude | `ask_device` protocol, Mac search handler, ranking, embeddings (optional) |
| D | Claude | NSOpenPanel + security-scoped bookmarks, Keychain, spike first |
| **I** | **Claude** | **NEW — derivation port, Swift → TypeScript. Differential harness FIRST, then port bottom-up, then dual-run, then cut over.** See `LANGUAGE_DECISION.md` §6. |
| E | DeepSeek | All §4.1 migrations + repositories, batch insert, enqueue, SQL reads, R2 content storage + encryption + **deletion** |
| F | DeepSeek | Typing indicator, multi-bubble, Sparkle, universal binary, LSUIElement |
| G | DeepSeek | Precompute at sync time, `precomputed_answers`, cache-hit path |
| H | Claude | Wire-up, e2e, delete the old chat head **last** |

**Track I is the long pole and it gates the new extractors.** Everything in
`RELATIONSHIP_MODEL.md` — `open_loops`, `lifecycle_stage`, `relationship_edges`,
`relationship_events` — is written **in TypeScript only, after I's harness exists.** Writing
them in Swift now means writing them twice.

**The old closed-vocabulary path (`selector.ts`, `reply.ts`, `waiting-on-me.ts`) stays live
until H proves the verifier holds. Do not delete it early.**

---

## 7. Known-good context for whoever builds this

- Digest upload works end to end (202). Chat answers from real data.
- `message_fts` exists and is populated: 97,137 messages, FTS query ~2 ms.
- `mirror.db` 43.9 MB · `digest_v2` 1.15 MB · 420 relationships · 4,617 voice exemplars
- 39% of relationships have zero voice exemplars; 9% have an open thread.
- Pre-existing test failures (do **not** chase): `cloud/db/src/schema.test.ts` (needs
  Postgres), `cloud/e2e/src/e2e.test.ts` (card rendering), `inbound-adapter.test.ts`.
- The uncommitted `Uploader.swift` DotEnv change breaks 4 Swift tests by reading the real
  `.env` — Track D fixes or reverts it first.
