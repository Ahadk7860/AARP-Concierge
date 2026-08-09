# Deepening the Relationship Model

If relationships are the wedge, the current model is too thin — and, more importantly, the
wrong *shape*. This proposes what Boi should keep.

---

## 1. The structural problem: everything is a snapshot

Today a relationship is one flat record, overwritten each sync:

```
message_count · sent_count · received_count · days_since_last_contact
momentum_90d · initiation_ratio · last_from_me · max_gap_days
unanswered_question · facts{dates,times,places,amounts,names}
understanding{ register, relationship_kind, open_thread,
               last_exchange_shape, topics, cadence_norm, voice_exemplars }
```

That is a good *state vector* and it cannot express a single one of the things people
actually care about in a relationship:

- "We used to talk weekly. We don't anymore." — needs history, not a snapshot
- "You said you'd send her the deck." — needs commitments, not topics
- "You've suggested dinner four times and never scheduled it." — needs recurring intent
- "She just started a new job." — needs life events
- "You two are both in three group chats with Dan." — needs a graph
- "He always replies in minutes; you take days." — needs latency asymmetry

`open_thread` is a **single nullable string**. A real relationship carries several open loops
of different kinds, with different ages, pointing in different directions.

**The fix is not a wider table. It is a small set of tables with the right grain.**

---

## 2. Proposed model

### 2.1 `relationships` — current state, one row per contact

Keep what exists, add identity and lifecycle:

| Column | Why |
|---|---|
| `lifecycle_stage` | `new` · `building` · `steady` · `cooling` · `dormant` · `rekindled` — the single most legible thing you can tell a user |
| `tie_context` | how you know them: `work` · `school` · `family` · `social` · `service` — distinct from `relationship_kind`, which is behavioural |
| `expected_gap_days` | the learned normal for *this* pair, not a global rule |
| `overdue_by_days` | `days_since_last_contact − expected_gap_days`. **The single best trigger in the product.** |
| `response_latency_me` / `_them` | median reply time each way |
| `effort_ratio` | message length + depth asymmetry |
| `importance` | user-declared, then derived — never purely derived |

`overdue_by_days` deserves emphasis: "you're 3 weeks past normal with Maya" is a sentence no
competitor grepping `chat.db` can produce without first building your metrics layer.

### 2.2 `relationship_metrics_daily` — the time series

One small row per contact per day (or per material change):

```
user_id, contact_id, day, message_count, momentum, initiation_ratio,
median_gap_days, response_latency_me, response_latency_them, register
```

This is what makes trajectory possible — warming, cooling, phase changes, seasonality,
"you've been drifting since March." Roughly 200 bytes/contact/day.

**Write only on material change**, not daily. Most relationships are unchanged most days, so
a change-only policy cuts this by 10–50× and keeps it viable at 100k users. Do not store full
digests for this — that's the 1.2 MB blob problem in `STRATEGY_VS_PALLY.md` §7.

### 2.3 `open_loops` — replaces the single `open_thread`

| Field | Values |
|---|---|
| `kind` | `question` · `promise` · `plan` · `favor` · `decision` |
| `direction` | `i_owe_them` · `they_owe_me` |
| `opened_at`, `age_days` | aging is what makes it actionable |
| `description` | derived, never a quote — same rule as `open_thread` today |
| `status` | `open` · `resolved` · `abandoned` |

`kind: promise` + `direction: i_owe_them` is the product. *"You told Dan you'd send the
deck 11 days ago"* is worth more than every general-knowledge answer combined, and it is
exactly what an agent grepping raw messages will get wrong — because a promise is a
structural pattern over a thread, not a string match.

### 2.4 `relationship_events` — episodic memory

`life_event` (job, move, birth, loss, illness, breakup) · `milestone` (birthday,
anniversary) · `repair` (who broke a long silence) · `conflict_marker` · `support_episode`.

Derived descriptions only. This is what lets Boi say *"she mentioned starting at Stripe in
March"* six months later — the compounding context that makes an assistant feel like it
knows your life.

### 2.5 `relationship_edges` — the personal social graph ⭐

Derived from group-chat co-membership and co-mention:

```
user_id, contact_a, contact_b, shared_groups, co_mentions, inferred_tie_strength
```

This is the most underrated asset available to you, and it is nearly free — group chat
membership is sitting in `chat.db` right now, unused. It enables a whole class of question
nobody else answers: *"who do I know through Dan?"*, *"who should I introduce?"*,
*"which of my circles have I dropped?"* — circles, not just contacts.

It also feeds identity resolution: two handles co-present in the same groups are more likely
the same person.

### 2.6 `memories`, `outcomes`, `corrections`, `draft_edits`

The moat tables from `STRATEGY_VS_PALLY.md` §5.2. `memories` matters doubly here — user-
declared facts ("Maya is my sister", "Tom and I fell out") are relationship context that is
**not inferable from message text at any level of sophistication**.

---

## 3. Why this is the wedge, concretely

Every row above is derived from data any competitor also has. The advantage is not access —
it's that **computing it is a genuine research problem, and you've already done the hard
part twice.**

`UnderstandingBuilder` already does structural classification with tuned thresholds, evidence
floors, and an honest `unknown` when below threshold. Look at what's in there: night/weekend
share, business-hours share, balance, dormancy decay, a documented −0.07 correlation someone
actually measured. That is months of calibration work, and it is why `relationship_kind` is
trustworthy where an LLM guessing from a transcript is not.

Extending that machine to lifecycle, promises, and graph edges is the same *kind* of work you
already know how to do. An agent-first competitor has to build all of it from zero, and will
be tempted to ask a model instead — which produces plausible, unfalsifiable, wrong answers.

**And it multiplies the moat.** Richer structure means more specific suggestions, which means
more outcome signal per interaction, which is the thing that actually compounds.

---

## 4. Costs, stated honestly

- **On-device compute.** Graph edges and event extraction over a full history are heavier
  than current metrics. Swift on a Mac handles it; the first full sync gets slower.
- **A larger derived-data surface in the cloud.** Life events and promises are more sensitive
  than message counts. Same privacy rule (derived, never quoted) but a bigger breach and
  regulatory footprint. Keep the salted contact ids and cascade delete.
- **More extraction is more to be wrong about.** A false "promise" is worse than no promise —
  it makes Boi nag about something never said. Every new extractor needs the same evidence
  floor and `unknown` discipline as `relationship_kind`, or you trade fabrication in the chat
  layer for fabrication in the data layer, which is far harder to detect.
- **Schema churn.** These tables will change shape as you learn. Version them from the start;
  the contract discipline already exists.

---

## 5. Order

1. `open_loops` — biggest product delta per unit work; `open_thread` is already close
2. `relationships` additions — `lifecycle_stage`, `expected_gap_days`, `overdue_by_days`
3. `relationship_metrics_daily`, change-only — unlocks all trajectory language
4. `relationship_edges` — nearly free, opens a question class nobody answers
5. `relationship_events` — highest extraction risk, do it last and gate it hardest
