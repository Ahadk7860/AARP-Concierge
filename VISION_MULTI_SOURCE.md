# Multi-Source Vision — Gmail, Slack, Calendar, and What It Forces Today

The roadmap is not "iMessage assistant plus some integrations." It is **one relationship
model fed by every channel a relationship actually lives in.** That distinction changes the
schema, and it changes it *this week* — before Track E creates tables.

---

## 1. Integrations settle the language question outright

Gmail, Slack, Calendar, Notion, Linear are **OAuth + REST + webhooks**. They are cloud-native.
The Mac has no role in any of them.

So if derivation stays in Swift on the Mac, you arrive at an incoherent architecture:

```
Mac (Swift)                        Cloud (TypeScript)
  derives iMessage relationships     derives Gmail relationships
  momentum, cadence, register        momentum, cadence, register
                    ↘             ↙
                  ...and then merges them?
```

Two implementations of "what a relationship is," in two languages, over two subsets of the
evidence, that must agree. That is not a tradeoff — it is untenable.

**Integrations force derivation into the cloud.** This is a stronger argument than anything in
`LANGUAGE_DECISION.md`, and it converts that recommendation from "worth doing" to
"structurally required."

**What stays on the Mac stays for a good reason.** iMessage has no API — Apple gives you
`chat.db` and nothing else. That is precisely why it is defensible: anyone can integrate
Gmail in a week; almost nobody does iMessage well. The Mac agent should stay narrow and
excellent — capture, decode, resolve, upload — and own nothing else.

---

## 2. The unification is the product

Most assistants bolt on integrations as **separate tool surfaces**: a Gmail tool, a Slack
tool, a Calendar tool. Ask about Dan and they search three places and concatenate.

Boi's version: Gmail, Slack, and iMessage are **evidence about the same person**.

> *"You owe Dan a reply — he emailed Tuesday, followed up on Slack Thursday, and you last
> replied 9 days ago. You normally answer him same-day."*

No per-source tool can produce that sentence. It requires one person, one cadence baseline,
one open loop, assembled across channels. That is the wedge from `STRATEGY_VS_PALLY.md` §5
extended to its natural conclusion — and it is *more* defensible than the iMessage-only
version, because the derivation work compounds across every source you add.

It also strengthens every existing metric. `initiation_ratio` computed across all channels is
a truer number than one computed from texts alone.

---

## 3. What this forces into the schema NOW

**Today's model is contact-centric**: `contact_id = h_ + HMAC(handle)`, one per iMessage
handle-cluster. `ContactResolver` already merges phone+email when the AddressBook agrees —
so the *concept* of a person with several identities exists, but it is Mac-local,
AddressBook-bound, and iMessage-only.

That does not survive contact with Gmail. Adding it later means rekeying every relationship
table — the expensive kind of migration.

**Introduce person/identity now**, while the tables are still being written:

```sql
-- The canonical entity. One row per human.
create table persons (
  user_id     text not null references users(user_id) on delete cascade,
  person_id   text primary key,          -- 'p_' + salted hash, same discipline as h_
  display     text not null,
  created_at  timestamptz not null default now()
);

-- Every handle we have ever seen, mapped to a person.
create table identities (
  user_id    text not null references users(user_id) on delete cascade,
  identity_id text primary key,
  person_id  text not null,
  source     text not null,        -- 'imessage'|'gmail'|'slack'|'calendar'|'linkedin'
  handle     text not null,        -- normalized; salted-hashed like contact_id today
  confidence text not null,        -- 'exact'|'inferred'|'unknown'   (I6 discipline)
  merged_by  text,                 -- 'addressbook'|'email_match'|'user_confirmed'
  as_of      timestamptz not null,
  unique (user_id, source, handle)
);

-- Source-agnostic. Replaces "message" as the unit of evidence.
create table interactions (
  user_id     text not null references users(user_id) on delete cascade,
  interaction_id text primary key,
  person_id   text not null,
  source      text not null,
  direction   text not null,        -- 'from_me'|'to_me'
  occurred_at timestamptz not null,
  thread_ref  text,
  content_ref text,                 -- pointer into R2, never the content itself
  length      int,
  meta        jsonb not null default '{}'
);
```

Then **every table in `V3_ARCHITECTURE.md` §4.1 keys on `person_id`, not `contact_id`** —
`open_loops`, `relationship_metrics_daily`, `relationship_edges`, `outcomes`, `memories`,
`draft_edits`.

For v3, iMessage is the only source, so it is one identity per person and behaviour is
identical to today. **The cost now is one extra join. The cost later is a rekey of every
relationship table.**

Keep `contact_id` as the iMessage identity handle inside `identities` — the Mac keeps
producing it, nothing on the device changes.

### 3.1 Cross-source identity resolution

The genuinely hard new problem, and it needs the same discipline as `relationship_kind`:

| Signal | Confidence |
|---|---|
| AddressBook record id (existing) | `exact` |
| Same email address across sources | `exact` |
| Slack profile email → Gmail address | `exact` |
| Name + company match | `inferred` — never auto-merge |
| Name similarity alone | **never merge** |

`ContactResolver`'s existing comment states the rule and it generalizes perfectly: *"failing
to merge understates one relationship, while merging two strangers puts one person's messages
in another person's row."* Under-merge by default. Offer a user-confirmable merge — and record
the confirmation in `memories`, where it becomes moat signal.

---

## 4. Roadmap and sequencing

| Phase | Source | Why this order |
|---|---|---|
| **v3** | iMessage | ships the person/identity model with one source |
| **v3.5** | **Gmail** | highest value per unit work — email is where promises and commitments actually live, and it is the richest `open_loops` source |
| **v4** | **Calendar** | meetings are high-signal interactions; also the cheapest integration |
| v4.5 | Slack | work relationships; noisy, needs per-channel filtering |
| later | Notion, Linear, GitHub | task context, weak relationship signal — resist until the core is proven |

Gmail before Slack because email carries explicit commitments in a way group chat does not,
and because `open_loops` extraction over email is where the product's best sentence comes
from.

Resist the long tail. Pally lists 20+ integrations; matching that list is how you lose. Three
sources unified beats twenty sources siloed.

### 4.1 Plumbing each integration needs

Standard, but real, and it should be built **once** as a source adapter interface rather than
per-integration: OAuth token storage (encrypted, refreshable), per-source sync cursors,
webhook receivers plus polling fallback, rate limiting, and backfill separate from
incremental sync.

```ts
interface SourceAdapter {
  source: string;
  backfill(scope, since): AsyncIterable<Interaction>;
  incremental(scope, cursor): AsyncIterable<Interaction>;
  identities(scope): Promise<Identity[]>;
}
```

The Mac agent implements this interface for iMessage like any other source. That keeps it
from being architecturally special even though it is operationally unique.

---

## 5. Scale, revised

Multi-source multiplies volume. A heavy Gmail account is 100k+ emails on its own — comparable
to the 97,137 iMessages already measured.

- R2 layout gains a source dimension:
  `users/{user_id}/{source}/{YYYY-MM}.jsonl.zst`
- `interactions` at 100k users × ~200k interactions = 20 B rows. **Postgres holds metadata
  only** and even then this is the shard-by-`user_id` point from
  `V3_ARCHITECTURE.md` §5 — the existing hash partitioning is what makes that physical rather
  than a redesign.
- **Incremental derivation stops being an optimisation and becomes the only viable design.**
  Rolling metrics updated per new interaction; never a full recompute.

---

## 6. What changes in the build, concretely

1. **`V3_ARCHITECTURE.md` §4.1 rekeys to `person_id`**, and gains `persons`, `identities`,
   `interactions`. DeepSeek's Track E must have this **before** it writes migrations — this is
   the urgent item.
2. **`LANGUAGE_DECISION.md` upgrades from recommendation to requirement.** Derivation moves to
   TypeScript; Track I is no longer optional.
3. **New extractors are written source-agnostically** — against `interactions`, not against
   iMessage rows. Same work, correct shape.
4. **The Mac becomes a `SourceAdapter`**, not the centre of the system.
5. Track A shrinks further — with no Swift digest producer and no `Contracts.swift`, the
   mirror problem is gone entirely.

**The single decision that matters this week**: key the new tables on `person_id`. Everything
else here can be deferred without penalty. That one cannot — it is cheap today and a rekey of
every relationship table later.
