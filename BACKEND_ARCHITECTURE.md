# Backend Architecture & Scale

**Question**: who uses the backend, and how does it survive 10 → 100k users?

**Short answer**: today one Railway service does every job in the system, synchronously, in
the HTTP request. The vision has **six workload classes with wildly different shapes**, and
the single most important structural change is separating them so a re-analysis backlog can
never starve a user waiting on a reply.

---

## 1. Who actually consumes the backend

| Consumer | Pattern | Latency budget | Scales with |
|---|---|---|---|
| **Mac agent** — shard upload | bursty, large bodies | minutes | users × history |
| **Mac agent** — `ask_device` / commands | persistent WebSocket | 1–3 s | **concurrent online Macs** |
| **Inbound iMessage** (Spectrum webhook + stream) | spiky, small | **< 2.5 s end-to-end** | conversations/day |
| **Outbound iMessage** (send, typing, bubbles) | per reply | < 200 ms/bubble | replies |
| **Agent runtime** | internal, model + tool calls | < 2 s | concurrent turns |
| **Integration webhooks** (Gmail push, Calendar) | spiky, fan-in | seconds | users × sources |
| **Integration pollers** (IMAP, API sync) | scheduled | minutes | users × sources |
| **Scheduled jobs** — derivation, precompute, briefs, nudges, retention, R2 reconciliation | batch fan-out | minutes–hours | users |
| **Re-analysis** | massive batch, occasional | hours | **total corpus** |
| **Web app** — OAuth, consent, settings, deletion | interactive | < 500 ms | users |
| **Voice / Watch / Shortcuts** (future) | interactive | < 1 s | sessions |
| **Ops** — evals, debugging, replay | internal | — | — |

Two rows dominate the design. **Concurrent online Macs** is the one nobody plans for, and
**total corpus** is the one that turns a good idea into a week-long job.

---

## 2. The six workload classes

They must not share a runtime, a connection pool, or a queue.

1. **Interactive** — inbound → router → agent → verifier → reply. Latency-critical, spiky.
2. **Ingest** — shard uploads, webhook fan-in. Throughput, bursty, must never block #1.
3. **Derivation** — incremental understanding per new interaction. CPU-heavy, continuous.
4. **Precompute** — cache-first answers, briefs. Scheduled per user.
5. **Proactive** — the right-moment nudge. Scheduled fan-out, timezone-aware.
6. **Re-analysis** — re-run extraction over every user's corpus after a model change.
   Preemptible, lowest priority, and the whole reason content lives in R2.

Today all six would run in the same Fastify process with `pg.Pool({max: 8})`. A re-analysis
job would take the pool and every user waiting on a reply would time out.

---

## 3. Target shape

```
                    ┌──────────────── EDGE (stateless, horizontal) ────────────────┐
  Spectrum ────────►│ webhook receiver — ack fast, enqueue, never compute inline   │
  Web/OAuth ───────►│ REST API                                                     │
  Mac agents ──────►│ WS GATEWAY — holds persistent connections (see §5)           │
                    └──────────────────────────┬───────────────────────────────────┘
                                               │
                          ┌────────────────────▼────────────────────┐
                          │ QUEUES — one per class, separate depth  │
                          │ interactive · ingest · derive ·         │
                          │ precompute · proactive · reanalysis     │
                          └────────────────────┬────────────────────┘
                                               │
   ┌───────────────┬───────────────┬───────────┴───────┬───────────────┬──────────────┐
   ▼               ▼               ▼                   ▼               ▼              ▼
 AGENT          ingest          derivation          precompute      proactive     reanalysis
 RUNTIME        worker          worker              worker          worker        worker
 (own pool,                     (incremental)                       (jittered)    (preemptible)
  own scaling)
   │               │               │                   │               │              │
   └───────────────┴───────────────┴─────────┬─────────┴───────────────┴──────────────┘
                                             ▼
        Postgres (hash-partitioned by user_id) · R2 (content shards) · Redis (cache,
        sessions, rate limits, budgets) · Search index (staged, §6)
```

**The agent runtime is its own service with its own pool.** It is the only thing a user waits
on; nothing batch may contend with it.

---

## 4. Scale switch points

Ordered by when they bite, not by importance.

| Trigger | What breaks | Change |
|---|---|---|
| **now** | `upsertRelationships` loops one INSERT per contact | batch multi-row insert |
| **now** | chat loads 1.2 MB JSONB per question | read normalized SQL |
| ~500 | Macs sync on the same schedule → thundering herd | jittered wake |
| ~1k | ingest transaction inside the HTTP request | **accept → enqueue → worker** |
| ~1k | `pg.Pool({max:8})` shared by everything | per-service pools + pgBouncer |
| ~2k | proactive briefs fire simultaneously | timezone-aware + jittered fan-out |
| ~5k | digest/content payloads in Postgres | payloads → R2, DB keeps metadata |
| ~10k | one process runs all six classes | **split workers, queue per class** |
| ~10k | inference is the top cost line | per-user budgets, cache-first, model tiering |
| ~20k | read contention on the chat path | read replicas |
| ~30k | 30k persistent Mac WebSockets | **dedicated WS tier or Durable Objects** (§5) |
| ~50k | one Postgres cluster | shard by `user_id` — hash partitions make this physical, not a redesign |
| ~100k | `interactions` at ~20 B rows | metadata-only in PG; consider ClickHouse for analytics |
| ~100k | cross-region latency | regional deploys, R2 is already global |

The hash partitioning by `user_id` already in the schema is the single best decision in the
current codebase for scale. It converts the ~50k shard from a redesign into an operational
task.

---

## 5. The connection problem nobody plans for

`ask_device` needs a live channel to each Mac. At 100k users with even 40% online, that is
**~40,000 persistent WebSockets**.

Options:

| Approach | Notes |
|---|---|
| Dedicated WS tier on Railway | ~10k connections/node → ~4–10 nodes. Needs sticky routing to reach a specific Mac. |
| **Cloudflare Durable Objects** | One DO per user = natural addressing, no sticky-routing problem, scales flat. **This is what Pally chose** (`pallykit-relay.pally.workers.dev`) and the reasoning is sound. |
| APNs wake + short-lived connection | Cheapest at rest; adds 2–5 s wake latency to every content question. |

**Recommendation**: start with a simple WS tier (fine to ~10k users), design the addressing as
`user_id → connection` from day one so a move to Durable Objects is a transport swap, and
keep APNs wake as the answer for the Mac-asleep case rather than the steady state.

---

## 6. Search, staged

| Scale | Implementation |
|---|---|
| now → ~1k | `ask_device` → on-device FTS5 (**measured: 2 ms**), R2 as backup + re-analysis source |
| ~1k → ~10k | + Postgres FTS over a recent window for the Mac-asleep case |
| ~10k+ | dedicated index — per-user SQLite in R2 over HTTP range requests, or a managed search service |

`search_messages()` is storage-agnostic (§4.2 of `V3_ARCHITECTURE.md`) precisely so these
moves never touch the agent.

---

## 7. Multi-tenancy and isolation

Already strong — protect it:

- per-user salt; `contact_id`/`person_id` arithmetically unrelatable across users
- every table hash-partitioned by `user_id`; every query scoped
- cascade delete verified against the catalog — **must be extended to R2**
  (`CONTENT_STORAGE.md` §2.1) and to every future source's stored data

Each new source adds a place data can survive deletion. **The deletion test must grow with
every source**, or the guarantee quietly becomes false.

---

## 8. Cost control

Inference becomes the top line well before infrastructure does.

- **Cache-first**: precomputed answers serve common questions with no agent turn.
- **Model tiering**: Flash Lite routes and answers; Pro only on verifier rejection.
- **Per-user budgets** in Redis, enforced at the agent runtime, with graceful degradation.
- **Incremental derivation**: never recompute a full corpus on a normal sync. Re-analysis is
  an explicit, scheduled, preemptible job.
- **Proactive frugality is free money**: the vision's "quiet for two weeks, then one thing
  that lands" is also the cheapest possible design. Precision and cost align here.

---

## 9. What the vision changes in my earlier recommendations

**Slack — you are right, I was wrong.** I had it at v4.5. It is a category error for the
consumer product: work-tool norms, and it drags positioning into a crowded productivity
space. **Removed from the consumer roadmap**; it belongs only to a deliberate professional-tier
pivot.

**Photos is the strongest source on your list and I had missed it.** Face and location
clustering is already done by Apple, on-device, and physical co-presence is a far better
closeness proxy than message volume. It is Mac-side only, which *strengthens* the on-device
story rather than weakening it. It slots beside Calendar, not late.

**Calendar should move up.** "Who you actually spend time with" plus meeting prep is high
value at low integration cost. Order: **Gmail → Calendar/Photos → Call history** (already
partly there in `CallHistory.swift`).

**On your trap #2 — social features.** `relationship_edges` as specified is safe: it is
`user_id`-scoped and hash-partitioned, so it is a graph *within one user's world*. That is
exactly the line you drew ("warm intros within one user's graph are fine"). It stays. Any
cross-user join remains an architecture change, not a feature — and the schema should keep
making it impossible rather than merely discouraged.

**On your trap #3 — third-party consent.** Worth being precise, because the line has already
moved: the R2 decision means iMessage content now leaves the device. Holding "read locally
only" for Gmail while shipping iMessage content to R2 would be incoherent. The defensible
version of the principle now is: **encrypted per-user, deletion that verifiably reaches every
store, read-only scopes, and minimum retention** — with Photos and call history as genuinely
on-device sources that keep part of the original claim intact. Each new source must extend the
deletion test, or the promise decays silently.

---

## 10. Build now vs. later

**Now (cheap, expensive to retrofit)**
- queue between ingest and processing — even a Postgres-backed one
- separate connection pools per workload class
- `user_id → connection` addressing for the WS gateway
- incremental derivation as the default path
- per-user budget hooks, even if the limits start effectively infinite
- deletion coverage for R2, and a test that grows with each source

**Later (genuinely deferrable)**
- read replicas, physical sharding, regional deploys
- Durable Objects migration
- dedicated search index
- ClickHouse for analytics

The distinction: everything in the first list is an *interface* decision that later work
depends on. Everything in the second is an *implementation* swap behind an interface you
already have.
