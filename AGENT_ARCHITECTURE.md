# Boi — Agent Architecture and Scale Plan

Written in response to: *"their agent turn can answer so many more questions… we need it to
be fluid… aren't we restricted on our design."*

Short answer: **you are right, I was wrong on an important point, and the pivot is far
cheaper than it looks.**

---

## 1. Where I was wrong

I defended "templated responses" as if they *were* the guarantee. They aren't. I conflated
two separate things:

| | What it is | Verdict |
|---|---|---|
| **Grounding** | Never assert a fact the evidence doesn't support | **Keep. This is the product.** |
| **Templating** | Only ever emit pre-written sentences | **Drop. This is one crude implementation of grounding.** |

Templates are the most restrictive possible way to achieve grounding, and they buy it at the
cost of everything fluid. There are better implementations: generate freely from tool
results, then **verify** each factual claim against those results before sending.

Grounding as a *generation constraint* gives you `{display} had an open question at the last
sync.` Grounding as a *verification pass* gives you fluid prose that still cannot invent
your friend's name. Same guarantee, radically different product.

So: adopt the agent. Keep the guarantee. They are not in conflict.

---

## 2. Their agent design, in detail

From the binary:

```
@anthropic-ai/claude-code          the Agent SDK, bundled and run on the user's Mac
ClaudeAdapter                       their wrapper
session-host.ts                     owns agent sessions
session-permission-server.ts        the canUseTool gate
terminal.ts / terminal-environment.ts   shell for the agent
control-channel.ts                  relay ↔ agent bridge
CLAUDE.md                           the agent's standing instructions
query( · sessionId · resume · permissionMode
tools: Read Write Edit Glob Grep Bash WebFetch Task
```

The loop: inbound iMessage → Cloudflare Worker relay (WebSocket) → local daemon →
`query()` against the Agent SDK with a resumed `sessionId` → agent calls tools → reply
returns over the relay → delivered by AppleScript through Messages.app.

Their integrations (Gmail, Notion, Linear, Slack, GitHub, Jira, Todoist, Splitwise…) are
almost certainly tools/MCP servers on that same loop. Their pricing page confirms the
ambition: **$200/mo Max tier with a dedicated phone number, outbound calls, purchases with
virtual cards, and browser sessions that sign into accounts.** They are not building a
relationship digest. They are building an executive assistant.

**Why it's fluid**: nothing constrains the output. The model writes, and tool results are
context, not a contract. That is exactly the flexibility you want — and exactly why it can
state something about your friend that no tool returned.

---

## 3. Why ours can be better — for real reasons, not defensive ones

Not "because we're more restrictive." Two concrete advantages:

### 3.1 Better tools, not fewer tools

Pally's agent runs `Grep` over raw `chat.db`. Yours would query **computed relationship
understanding** that already exists on the Mac:

`momentum_90d` · `initiation_ratio` · `days_since_last_contact` · `max_gap_days` ·
`cadence_norm` · `register` · `relationship_kind` · `open_thread` · `last_exchange_shape` ·
`unanswered_question` · `topics` · voice exemplars · `whole_life` aggregates

An agent grepping a SQLite file has to *infer* "you've gone quiet with Maya." An agent
calling `relationship_metrics(contact)` is *told*, with a number. That's better answers on
exactly the questions this product exists for — and it's 11,000 lines of Swift you have
already written and would keep in full.

**The Mac pipeline is the moat. The chat module was never the moat.**

### 3.2 You never hold other people's words

**Corrected.** An earlier version of this section claimed Pally goes dark when the Mac
sleeps. It doesn't. The binary contains `history_export_start`, `presign`,
`CompleteMultipartUpload`, `X-Amz-Signature`, and `r2.cloudflarestorage.com` — they upload
iMessage history to Cloudflare R2, so their cloud answers content questions with the laptop
shut. Their "keep this Mac on" line is about sending and fresh capture. **There is no
availability advantage here.**

The real difference is what leaves the device. Pally's servers hold your users' actual
conversations — and their contacts' conversations, from people who never signed up for
anything. Boi's contract ships derived understanding and the user's *own* redacted exemplars,
never counterpart prose.

That is a genuine differentiator, but it is a **trade, not a win**: with the Mac asleep, Boi
cannot answer "what did Maya say about the trip" and Pally can. See
`STRATEGY_VS_PALLY.md` §5A.1 for the four options and which to pick.

The advantage is worth something only if you say it out loud and someone cares. It is a
positioning bet on people who hesitate to hand a startup their message history — a real
audience, but one you have to go get.

---

## 4. How restricted are you actually? Less than it feels

The rigid part is **900 lines**:

```
cloud/chat/src/pipeline.ts        35
cloud/chat/src/selector.ts       143
cloud/chat/src/reply.ts          260
cloud/chat/src/waiting-on-me.ts   70
cloud/chat/src/draft.ts          392
```

That's the whole closed-vocabulary machine. Everything else survives a pivot untouched:
`mac/Sources/BoiKit` (11,017 lines), the contracts, the DB with its per-user salting and
hash partitioning, auth, the channel, the encrypted turn store, retention.

You are not architecturally trapped. You have a data platform with a narrow chat head bolted
on. Replace the head.

---

## 5. Target architecture

```
inbound text
   │
   ▼
ROUTER ─ cheap model, sees text only
   │
   ├─ relationship intent ─┐
   ├─ general intent ──────┤
   └─ unsafe ─ refuse      │
                           ▼
              ┌────────────────────────────┐
              │  AGENT (cloud, Flash-tier) │
              │  fluid prose, resumable    │
              └────────────────────────────┘
                     │ tool calls
        ┌────────────┼─────────────┬──────────────┐
        ▼            ▼             ▼              ▼
  relationship   whole_life    web/general   mac_action
  tools (SQL     tools         (WebFetch)    (send iMessage,
  over the                                    needs Mac awake,
  relationships                               needs approval)
  table)
        │
        ▼
  ┌──────────────────────────────────────┐
  │ VERIFIER — every factual claim about │
  │ a person must map to a tool result   │
  │ from THIS turn. Unsupported claim →  │
  │ regenerate once, then degrade.       │
  └──────────────────────────────────────┘
        │
        ▼
   deliver (same channel, same idempotency)
```

The verifier is the whole ballgame. It replaces the exact-text gate and preserves the
guarantee **without** constraining phrasing. Your existing `fabrication.eval.test.ts` becomes
its test harness rather than the template gate's.

**Tools, phase 1**: `waiting_on_me` (exists), `relationship_metrics`, `gone_quiet`,
`search_relationships`, `whole_life_summary`, `draft_message`, `send_message`.
Note `send_message` is the one that mutates the world — keep Pally's instinct here
("never does anything big without asking first") and require explicit confirmation.

---

## 5A. Search — the killer use case, and it needs no upload

iMessage search is genuinely bad. "What did Maya say about the trip" is the question people
actually have, and Apple answers it poorly. This is the wedge — and **it does not require
putting message content in the cloud.** Search needs an *index*, and the index can live
where the messages already are.

### What already exists

`mirror.db` on a real account:

```
97,137 messages
message_fts — SQLite FTS5, already built and populated
FTS query 'trip'              → 302 rows in   2 ms
FTS two-term, top 50          →              1 ms
```

Full-text search over the entire history returns in **single-digit milliseconds**. The
expensive infrastructure is done. What's missing is the path from a text message to that
index, and semantic recall for when the user's words aren't the words in the thread.

### Design

```
"what did maya say about the trip?"
        │
   cloud agent  ──── search_messages({ query, who?, when?, limit })
        │                     │
        │              WebSocket to Mac
        │                     ▼
        │         hybrid retrieval, on-device:
        │           • FTS5 keyword        ~2 ms
        │           • local embeddings    ~100–300 ms
        │           • filter by handle / date from the hints
        │                     │
        │              top-N snippets ────┘
        ▼
   compose answer → deliver
```

The user's hints ("Maya", "around the trip", "a few weeks ago") map directly onto
`handle` and `sent_at` filters that already exist as columns on `message`. Narrowing by
contact before searching is what makes this beat Apple's search, which cannot.

**Latency budget**: 2 ms FTS + ~200 ms embedding search + ~300 ms round trip + ~1 s compose
≈ **1.5 s**. Acceptable, and most of it is the model.

**Semantic layer**: start with FTS only — it covers more than it seems, since people
usually remember a distinctive word. Add embeddings when recall proves insufficient. On-device
options: Apple's `NLEmbedding` (free, built into macOS, no download) or a small model via
MLX/CoreML (~90 MB, better quality). Embed once at sync, store beside the mirror.

### The privacy line, stated precisely

There is a real distinction worth being careful about:

- **Showing the user their own messages** — not a privacy event. They can already read them.
- **Storing those messages on a server** — the thing the promise is about.

A snippet transits the relay to reach the phone. Boi's turn store is already encrypted
(`TurnVault`, `EncryptedPrivateStore`), so it's encrypted at rest and never held in the
clear. The honest claim becomes:

> *Your messages stay on your Mac. Boi searches them there and sends only the answer.*

That is weaker than "never leave your Mac" and still far stronger than Pally, whose full
history sits in R2.

### The Mac-asleep gap, and an honest degradation

This is the one real cost. Mitigations, in order of preference:

1. **Cache a derived searchable summary in the cloud** — per-thread topics and date ranges,
   no prose. Answers *"you and Maya discussed the trip around March 3"* with the Mac off,
   then offers the exact quote when it wakes. Consistent with the promise.
2. **Wake the Mac.** `WakeScheduler` / `WakeSchedulerHelper` already exist for scheduled
   syncs; on-demand wake is harder but the machinery isn't foreign.
3. **Say so plainly.** *"I need your Mac awake to read that thread — want me to answer when
   it's back?"* then follow up. Async is fine in a texting product; nobody expects a chat
   thread to be synchronous.

---

## 5B. If you switch to cloud content later — the real cost

**~4–6 weeks, and about one week of it is throwaway** *provided you do one thing now*:
define the search tool contract to be storage-agnostic.

```ts
search_messages({ query, who?, when?, limit }) -> [{ contact, when, snippet, thread_id }]
```

Implement it device-side today. If you later move content to R2, you swap the implementation
behind that signature. The agent, prompts, tool schemas, evals, ranking logic, snippet
formatting, and UX all survive untouched — because they were never coupled to where the
bytes live.

| Work | Effort | Reusable from device-first? |
|---|---|---|
| Chunked upload from Swift → R2 | 3–5 d | new |
| Cloud ingest + storage schema | 3 d | new |
| Embedding pipeline + vector index | 5–7 d | partly — same model choice, new host |
| Search tool, cloud implementation | 2–3 d | **contract, ranking, evals all reused** |
| Backfill existing users | automated | — |
| Consent flow, policy, legal review | 5 d+ | new |
| **Device index build** | — | **~1 week discarded** |

So the cost of going device-first and changing your mind is **roughly one week of rework**,
against the benefit of shipping the feature months earlier, keeping the promise while you
learn, and finding out from real usage whether the Mac-asleep case matters at all.

That is a cheap option to hold. Take it.

---

## 6. Where the agent runs — decide this now

| | Cloud (recommended) | On-device (Pally) |
|---|---|---|
| Works with Mac asleep | **yes** | no |
| Data exposure | derived digest only, already redacted | nothing leaves the Mac |
| Update cadence | instant | requires app release |
| Tool surface | your data + web | + local files, shell |
| Ops cost | you run it | user's machine |
| Security blast radius | normal web service | RCE surface on user's Mac |
| Send-as-user | needs Mac callback | native |

**Recommendation: cloud.** It matches the data model you already committed to, it beats them
on availability, and it avoids putting a shell-capable agent on a machine full of someone's
private messages. Keep a thin Mac action channel for the things that genuinely need the Mac.

This is the most expensive decision to reverse. Make it deliberately, now.

---

## 7. Scale plan — 10 → 100k

### What breaks, and when

**Today's real limits, measured against the current code:**

| Trigger | What breaks | Fix | Reversible? |
|---|---|---|---|
| ~100 users | `upsertRelationships` loops **one INSERT per contact** (`repository.ts:519`) — 420 round-trips per sync | batch multi-row insert / `COPY` | easy |
| ~100 users | ingest runs the whole transaction **inside the HTTP request** | accept → enqueue → worker | moderate |
| ~500 users | Macs sync on the same schedule → thundering herd | jittered wake times | easy |
| ~1k users | `pg.Pool max: 8` (`main.ts:290`) | pgBouncer / raise + tune | easy |
| **~1k users** | **`latestDigest` loads the full 1.2 MB JSONB on every chat message** | **read the normalized `relationships` table with SQL predicates; never load the blob** | easy now, painful later |
| ~5k users | digest payloads in Postgres: 1.2 MB × users × syncs/day | payloads → **R2/object storage**, DB keeps metadata + normalized rows | moderate |
| ~10k users | agent inference becomes the dominant cost line | model tiering, per-user budgets, cache the daily brief | moderate |
| ~10k users | single primary saturates on read | read replicas for the chat path | moderate |
| ~50k users | one Postgres cluster | **shard by user_id — the hash partitioning already in place makes this physical, not logical, work** | hard but pre-paid |
| ~100k users | 100k persistent WebSockets (if adopted) | Durable Objects / dedicated gateway | hard |
| ~100k users | latency across geographies | regional deploys, digest replication | hard |

### The one to fix immediately

**`latestDigest` reads a 1.2 MB JSONB blob and the chat path parses all 420 relationships in
memory — for every single question.** Meanwhile `upsertRelationships` has *already
normalized every relationship into its own row*. The data is sitting there, indexed, and the
read path ignores it.

At 10 users this is invisible. At 1k it is your first outage. And it gets much harder to
change once agent tools are written against the in-memory digest object — so **write the
tools against SQL from day one**, not against `DigestV2`.

That single decision is the difference between an architecture that scales to 100k and one
that has to be rewritten at 5k.

### Storage math worth internalizing

1.2 MB per digest. Daily syncs.

- 1k users → 1.2 GB/day → 36 GB/month of JSONB churn
- 10k users → 12 GB/day → autovacuum becomes your on-call pager
- 100k users → 120 GB/day → Postgres is the wrong store, full stop

Keep **one** current digest per user in object storage, plus normalized relationships in
Postgres for querying. Historical digests are a product feature nobody has asked for yet;
don't pay for them by default.

---

## 8. Sequencing so nothing is wasted

**Phase A — unblock (≈2 weeks)**: NSOpenPanel + bookmarks, Keychain, Sparkle, universal
binary, conversation-first pairing. Independent of the agent decision; do it regardless.

**Phase B — de-risk the data path (≈1 week)**: batch inserts, enqueue ingest, chat reads
from the `relationships` table, payloads to R2. **Do this before writing agent tools**, so
the tools are built on the scalable read path.

**Phase C — agent head (≈2 weeks)**: router, cloud agent, relationship tools over SQL,
verifier, evals. Delete `selector.ts`/`reply.ts`/`waiting-on-me.ts` at the end, not the
start — keep the licensed path running until the verifier demonstrably holds.

**Phase D — reach (ongoing)**: more tools, `send_message` with approval, then integrations.

Contract codegen (Swift + zod from `contracts/schema/`) slots into B or C; it stops the drift
class permanently and matters more once tool schemas multiply.

---

## 9. The honest competitive read

Pally is building an executive assistant with 20+ integrations and a $200/mo tier. You will
not out-integrate them soon, and chasing that is how you lose.

What you can win: **the relationship layer they can't compute.** Their agent greps a SQLite
file. Yours has a per-contact understanding model built on-device with real metrics. If
someone asks "who am I drifting from and what do I say," you can answer with evidence and
they can only guess convincingly.

Beat them on: depth of relationship reasoning, availability with the Mac closed, and
"it never makes things up about people you care about." Match them on: fluidity — which,
per §1, costs you nothing you should have wanted to keep.
