# Amendment 001 — `digest.v1` carries what the gist producer needs

**Author:** the planning session. **Date:** 3 Aug. **Status:** approved, unimplemented.
**Amends:** `contracts/schema/digest.v1.json`, and § 1 and § 6 of `prompts/CONTRACTS.md`.

A track never amends a contract. This document is the amendment; Track E prompt `03`
implements it. It exists because Track E found, correctly, that the gist producer is on
the wrong side of the process boundary — and the fix is not the one that looks obvious.

## What Track E found

Verified independently before writing this:

1. `boi_intel.gist.build_gists(db_path, …)` reads a `chat.db`. `ThreadStats` is built by
   SQL over `message`, `chat_message_join` and `handle`. There is no constructor that
   takes a digest.
2. `digest.v1.$defs/relationship` cannot supply what `ThreadStats` needs.
3. There is no route carrying a gist to the cloud. `grep -n gist` over
   `contracts/openapi/boi-api.v1.yaml` returns nothing.

So the bridge was given a corpus path (`BOI_CORPUS_DB`), which puts the corpus in the
cloud — the one thing the whole design forbids. That seam ships as a documented deviation
and this amendment removes it.

## The two candidate fixes, and why the smaller one wins

**Move gist production to the Mac** is what `BOI_ARCHITECTURE.md` § 6.6 says, and it is
right about the destination. But it costs a port: `gist.py` (531 lines), `threads.py`
(211) and `facts.py` (349) into Swift, plus a `POST /v1/gists` route. `facts.py` is the
worst possible thing to port — 349 lines of regex whose *case sensitivity is load-bearing*
(`_CS = 0 # capitalisation IS the signal, so IGNORECASE destroys it`) — and two
implementations that must agree token-for-token or the fabrication gate diverges from the
thing it gates.

**Carry the missing inputs in the digest** costs four fields. The producer stays in Python,
in the cloud, unported. The corpus stays on the Mac, which is the actual invariant.

Take the second. The first is the right shape for the day a local model produces T1 gists
on-device, which is a post-MVP move, not this week's.

## The delta

Four additions to `digest.v1.$defs/relationship`. Three are statistics; the fourth needs
an argument, below.

| Field | Type | Why it is needed | Consumer |
|---|---|---|---|
| `last_from_me` | boolean | `classify()` gates `action_needed` on `not stats.last_from_me`. **Without it the state the entire daily brief exists to deliver can never be produced** — a digest-driven producer silently emits only `fading` and `dormant`. Also worth +0.35 in `priority()`, the largest single term. | `gist.classify`, `gist.priority` |
| `max_gap_days` | integer | `classify()` gates `revived` on it. | `gist.classify` |
| `unanswered_question` | boolean | +0.20 in `priority()`, and selects the specific `sql_gist_text` branches. | `gist.priority`, `gist.sql_gist_text` |
| `facts` | object | The allowlist `sql_gist_text` and `deadline_for` read. Same shape as `gist.v1.facts`. | `gist.sql_gist_text`, `gist.deadline_for` |

`momentum` needs no new field: `ThreadStats.momentum` is a property over
`messages_last_90d / messages_prior_90d`, and `relationship.momentum_90d` already carries
exactly that ratio. The digest-driven builder supplies it directly.

`recent_inbound_text` is **not** added and must never be. It is the other person's prose.
`ThreadStats` documents it as the one field that stays on the Mac, and a digest-driven
producer runs without it — which is why `facts` has to cross instead.

### The argument about `facts`

`facts` carries strings derived from the other person's messages, and `digest.v1` has so
far been aggregates only. That looks like a boundary widening. It is not, and the reason
is in `gist.v1`'s own schema:

> `facts`: **THE FABRICATION-GATE ALLOWLIST, and it crosses the digest boundary.** Every
> string here is subject to the same no-verbatim rule as `gist` itself. Max 3 words and
> 40 chars.

These exact tokens, under these exact caps, are already licensed to leave the Mac — inside
a `gist.v1`. Moving them into `digest.v1` changes the envelope, not the information. What
changes is *where the check lives*, and that is a real obligation:

**`scripts/check_voice_pack_leak.py` and the fixture validator must apply the same
per-token cap and no-verbatim rule to `digest.relationship.facts` that they apply to
`gist.facts`.** A cap enforced in one container and not the other is a cap that is not
enforced. This is the single most important line in this amendment.

### Required, not optional

All four are **required**. An optional field looks kinder and is worse: a Mac that has not
been updated would upload a digest that validates, and the cloud would produce gists that
can never be `action_needed` — no error, no alarm, and a morning brief that quietly stops
containing the only thing it exists to say. Required means an old Mac is rejected at the
boundary, loudly, on the first upload.

The cost is that every existing digest fixture becomes invalid the moment the schema
lands. That is why schema, Swift producer, Python consumer and fixtures land in **one
prompt** rather than one per track — see below.

## What this does not change

- `digest.v1` stays free of message text. `facts` is tokens, capped, allowlisted.
- No `POST /v1/gists` route. No Swift port of the producer.
- `voice_pack.v1`, `gist.v1`, `draft_bundle.v1`, `brief.v1`, `outbound.v1`, `inbound.v1`
  and the `Channel` interface are untouched.
- The three `is_from_me` guards are untouched.

## Implementation

Track E prompt `03`, which is new. The existing `03` and `04` renumber to `04` and `05`.
One prompt, because a schema change that lands without its producers leaves `main` red:

1. `contracts/schema/digest.v1.json` — the four fields, required.
2. `mac/Sources/BoiKit/Contracts.swift` and `DigestBuilder.swift` — emit them. The Mac
   already computes every one of these; `MessageReader` has the data and `facts`
   extraction is the only new work.
3. `intelligence/boi_intel/gist.py` — a `ThreadStats` constructor that takes a
   `digest.v1` relationship. **Additive.** `build_gists(db_path, …)` stays exactly as it
   is: it is what the Mac-side producer will use when the port eventually happens, and
   deleting it now would throw away the tested path.
4. Fixtures, and the leak-checker obligation above.
5. Delete `BOI_CORPUS_DB` / `BOI_CORPUS_DIR` and the `bridge.ts` header comment.

### Grants added after the prompt was written

Enumerating the files by hand missed three groups, all found by Track E during `03`:

- **`cloud/api/src/schemas.ts`** and its two tests. The zod schema is a hand-written
  mirror of the JSON Schema, and `differential.test.ts` exists to catch exactly the
  divergence a one-sided amendment would create. Four tests fail until it is updated, so
  "one commit" and "do not touch Track D" could not both hold.
- **`mac/Sources/BoiKit/Fact*.swift`** and their tests. Fact extraction is an 805-word
  vocabulary and a regex table; forcing it inside `DigestBuilder.swift` to satisfy an
  ownership regex is the guard rail deforming the code it guards. Its own files.
- **`intelligence/tests/test_{gist,threads,facts}.py`**, for the same reason the
  producers are granted.

`scripts/generate_fact_vocabulary.py` needs no grant — `scripts/` is already
foundation-owned append-only, so a new file there announces itself and is recorded in
`NOTES.md` like any other shared append.

Track E has a sanctioned frozen exception for `contracts/schema/digest.v1.json`,
`mac/Sources/BoiKit/Contracts.swift` and `intelligence/boi_intel/contracts.py` **for this
prompt only**, on the same announce-don't-block basis as the Spectrum exceptions.
