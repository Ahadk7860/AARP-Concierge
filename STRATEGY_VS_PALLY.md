# Boi vs Pally — What to Change, What to Keep, What to Refuse

Recommendations from the teardown in `COMPETITOR_PALLY.md`. Opinionated on purpose.

---

## 0. The headline

**Adopt their plumbing. Adopt their fluidity. Refuse their trust model and their
deployment model.**

Pally is ahead on everything boring and operational — permissions, updates, credentials,
pairing, packaging. Copy all of it; it's days of work and it's costing you time now.

Pally is also right about fluidity. An agent that answers anything beats a template that
answers one thing, and no amount of principle changes that. `AGENT_ARCHITECTURE.md` §1
corrects my earlier position: templating was never the guarantee, it was a crude
implementation of it. Take the agent.

What you should *not* copy is (a) an ungrounded generation path that can invent facts about
the people the user cares about, and (b) putting a shell-capable agent on the user's Mac.
Both are avoidable while keeping everything that makes their product feel good.

**And none of the above is a moat.** All of it is copyable in a quarter, in both directions.
The moat is §5.

---

## 1. Adopt now — high value, low risk

### 1.1 NSOpenPanel + security-scoped bookmarks instead of FDA ⭐ do this first

**Why**: it is your single largest onboarding cost and your largest *development* cost. You
have regranted FDA after every rebuild this week. Users hit a System Settings trip, a
toggle, and a relaunch — the highest-drop-off moment in the whole funnel. Pally replaced it
with one click and markets the difference.

**Effort**: 2–4 days, but **spike it in half a day first** — see §6.

**Tradeoffs**:
- Bookmarks are per-bundle-identity. Re-signing invalidates them, so a bad release can
  silently un-grant everyone. Mitigate by detecting resolution failure and re-prompting.
- Apple has tightened user-selected consent for `~/Library` before and may again. FDA is
  the boring path that will never break. Keep FDA as a documented fallback rather than
  deleting `FullDiskAccess.swift` outright.
- Your LaunchAgent runs `Contents/MacOS/Boi --sync` headlessly; it must resolve the
  bookmark itself. Same bundle, so this should work — **verify explicitly in the spike**,
  because a scheduled sync that can't read `chat.db` fails silently at 3am.

### 1.2 Keychain instead of `.env`

**Why**: this is not theoretical — the uncommitted DotEnv change is breaking 4 Swift tests
right now by reading your real credentials file during unit tests. Pally uses
`PALLYKIT_KEYCHAIN_SERVICE`. Credentials in a plaintext dotfile inside Application Support
is also a straightforwardly worse security posture.

**Effort**: 1–2 days. **Tradeoff**: Keychain access can prompt; needs care for headless
LaunchAgent runs (use a keychain item ACL that permits your signed binary).

### 1.3 Sparkle auto-update

**Why**: you shipped four fixes this week, each needing a manual DMG, re-copy, and FDA
regrant. With bookmarks (§1.1) *and* Sparkle, a fix reaches users without them doing
anything. Pally ships EdDSA-signed appcasts.

**Effort**: 1–2 days. **Tradeoff**: you now own an update channel and its signing key. A
bad auto-update reaches everyone instantly — pair it with a staged rollout.

### 1.4 Conversation-first pairing ⭐ structural, not cosmetic

**Why**: this is the one that would have prevented the identity split entirely. Pally's user
texts the assistant, receives a code, types it into the app. Because the code is *issued by
the chat*, the texting identity and the device identity are bound at pairing **by
construction**. My `unroutableHandle` guard merely *detects* that failure after the fact;
their design makes it unrepresentable.

**Effort**: 3–5 days server + Mac. **Tradeoff**: replaces the `BOI_USER_ID`/`BOI_DEVICE_TOKEN`
env flow you currently depend on for dev; keep an env override behind a dev flag.

### 1.5 Universal binary + `LSUIElement`

`arm64`-only excludes every Intel Mac — and Intel Macs are exactly the "old Mac that stays
plugged in at home" this product wants. One line in the build. Menu-bar-only presentation is
a small polish win. **Effort**: hours.

---

## 2. Adopt, but not by copying

### 2.1 Kill contract drift with codegen — do NOT rewrite the Mac app in Bun

Pally runs one language end to end: `packages/protocol` and `packages/imessage` are shared
by daemon and cloud. They structurally cannot have the `digest.v2` drift bug that cost you a
week.

**The tempting conclusion is to rewrite `mac/` in Bun/TypeScript. Don't.** You would be
throwing away `TypedStream.swift`, `MetricLibrary`, `UnderstandingBuilder`, `Redaction`, and
`ContactResolver` — months of genuinely hard work, much of it the actual product — to solve
a problem that has a much cheaper fix.

**Do this instead: generate both mirrors from `contracts/schema/*.json`.** The frozen JSON
Schema is already declared the arbiter. Generate the zod validators and the Swift `Codable`
types from it at build time, and fail CI when generated output differs from committed
output. The entire class of bug disappears — including the enum drift, which no amount of
code review caught.

**Effort**: ~1 week, versus ~3 months for a rewrite. Captures most of the benefit.
**Tradeoff**: codegen is machinery to maintain, and hand-written schemas sometimes express
things generators handle badly. Start with the enums and required-key sets, which is where
all your actual drift has occurred.

### 2.2 Split the app: permissions shell vs. worker

Pally's 989 KB Swift shell owns TCC and UI; the fat daemon owns logic. This is worth
imitating in *structure* even in pure Swift, because it makes the permission surface small
and auditable, and lets the worker restart without touching grants.

**Effort**: moderate refactor. **Tradeoff**: IPC complexity you don't have today. Defer
until after §1.

### 2.3 Product gaps worth closing

- **Opt-in history import** (`PALLYKIT_HISTORY_IMPORT_DISABLED`, a checkbox in their setup).
  Boi always ingests everything. Making this a choice is a trust win at near-zero cost.
- **Three separately-grantable setup steps with live status + Refresh.** Copy this UI
  pattern regardless of which permission mechanism you land on.
- **Attachments** — they index them, you don't touch them. Genuine capability gap, but it
  is also a large new privacy surface. Deliberate decision, not a default.

---

## 3. Refuse

### 3.1 LinkedIn Voyager scraping

An undocumented internal API driven with the user's session, against ToS, with a
`ratelimiter.ts` that suggests they've already been burned. They have accepted legal and
platform risk. You should not inherit it to match a feature list.

### 3.2 A general agent with `Bash` on the user's Mac

This is the real fork, so be explicit about what they've built: Claude Code with
`Read`/`Write`/`Edit`/`Bash`/`WebFetch`, running on the user's machine, reachable from an
inbound iMessage, gated only by a permission server.

That means **an inbound text is an input to a tool-using agent with shell access on a
machine holding the user's entire message history.** Prompt injection there is not a
content-safety issue; it is remote code execution reachable by anyone who can text the user's
assistant number. Maybe their permission server is airtight. It is a very large surface to
have to be right about.

You do not have to accept that risk to be competitive, and "we do not run a shell on your
Mac" is a defensible position — especially for the exact audience that hesitates over
handing an app their message history.

---

## 4. What you already do better — protect these

1. **No fabrication about relationships.** Model output never reaches the user in the
   licensed lane; every sentence is evidence-licensed. Pally's agent will confidently say
   things about your friends that its context does not support. This is your product.
2. **Privacy engineering.** Per-user salted HMAC contact ids, on-device redaction, hash-
   partitioned cross-user isolation with catalog-verified deletion. Nothing in their bundle
   suggests comparable rigor.
3. **Contract-first with a frozen arbiter.** The differential test caught real drift in both
   directions. The v2 gap was that it was never *applied* to v2 — a coverage failure, not a
   design failure. Now fixed.
4. **Cost per message.** Your licensed lane is one small selector call plus deterministic
   templates. Theirs is an agent turn with tool calls. At scale, you can serve the daily use
   case at a fraction of their inference cost. That is a durable structural advantage —
   don't casually give it up by making everything an agent turn.

---

## 5. The moat

### 5.1 The test that separates a moat from a head start

Ask one question of every candidate advantage:

> **Could a well-funded competitor reproduce this on their first day of operation, from data
> that already exists on the user's Mac?**

If yes, it is a head start, not a moat. Apply it honestly:

| Candidate | Backfillable from `chat.db`? | Verdict |
|---|---|---|
| Reading iMessage history | yes, trivially | not a moat — Pally already does it |
| Derived metrics (momentum, cadence, register) | yes — recomputable from the same history | **head start, ~2–4 months** |
| Relationship trajectories over time | yes — history contains the whole time series | head start |
| Voice exemplars from past messages | yes | head start |
| Integrations breadth | n/a — pure engineering spend | Pally wins this; don't race |
| **What the user did after Boi suggested it** | **no** | **moat** |
| **Which drafts they sent, edited, or ignored** | **no** | **moat** |
| **Facts the user told Boi directly** | **no** | **moat** |
| **Corrections the user made to Boi's claims** | **no** | **moat** |

Everything in `chat.db` is available to every competitor on day one. **Only what happens
*because Boi existed* is not.** The moat is the interaction record, and today you record
none of it.

### 5.2 The four assets to start accumulating now

**A. Outcome ledger.** For every suggestion — a nudge, a draft, a surfaced open thread —
record what happened: sent verbatim, edited (and the diff), ignored, and whether the other
person replied. This is unbackfillable, compounds daily, and it is the only way to answer
"is Boi actually working?" — a question Pally structurally cannot answer either, so it's
also a wedge.

**B. User-authored memory.** *"Maya is my sister." "I'm avoiding Tom." "Don't nudge me about
work people on weekends."* None of this is derivable from message text. It makes the product
better immediately, and it is switching cost: leaving means re-teaching a new assistant
everything you told this one.

**C. Voice learned from edits.** You already extract voice exemplars from history — so does
anyone who reads `chat.db`. What they cannot get is *the delta between what Boi drafted and
what the user actually sent*. That signal makes drafts converge on the user's real voice.
Pally claims drafts that "sound like you"; without edit feedback they can only imitate,
never improve.

**D. Correction log.** When the user says "no, that's wrong" or "Maya already replied,"
capture it. Feeds the verifier's eval set and the understanding model.

None of these require the agent. **All of them should be built into the schema before the
agent ships**, because the agent is what generates the events worth recording, and
retrofitting instrumentation after launch means throwing away months of signal.

### 5.3 What the moat is *not*

It is not "we don't hallucinate." That's table stakes you can hold better than they can, and
it's a reason to be trusted — but a competitor can bolt a verifier on in a quarter.

It is not the metrics library. It's excellent work and it's 2–4 months of head start, no
more.

Head starts are worth having; they're what buy you the time to build §5.2. Just don't
mistake them for durable.

---

## 5A. The cloud agent, in full

### The tension nobody can dodge

Fluid conversation eventually needs message *content*. "What did Maya say about the trip?"
cannot be answered from metrics. But `digest.v2` deliberately carries **no counterpart
prose** — that is a load-bearing privacy promise, not an oversight.

Pally resolves this by **exporting the history to their cloud**. Confirmed in the binary:
`history_export_start`, `assistant_import_start`, `uploadId`, `presign`,
`CompleteMultipartUpload`, `X-Amz-Signature`, `r2.cloudflarestorage.com` — presigned
multipart uploads to Cloudflare R2. The on-device agent handles capture and local execution;
the message content itself lives on their servers.

**Correction to an earlier draft of this document**: I claimed Pally goes dark when the Mac
sleeps. That is wrong. Their cloud holds the content, so they answer content questions with
the laptop shut. Their "keep this Mac on" requirement is about *sending* and *fresh capture*,
not about answering. Boi has no availability advantage here — the real difference is what
leaves the device, not who is awake.

**Resolution: cloud brain, device retrieval.**

```
cloud agent (fast model, always up)
   ├─ relationship tools   → SQL over normalized rows        ~50ms
   ├─ memory / outcome     → SQL                             ~50ms
   ├─ general knowledge    → model / web                     ~1s
   └─ ask_device(...)      → WebSocket to the Mac, which     ~1–3s
                             searches locally and returns
                             a DERIVED answer, never raw prose
```

The Mac becomes a privacy-preserving retrieval tool. Raw messages never leave it; the cloud
receives an answer, not a corpus. When the Mac is asleep, that one tool is unavailable and
the agent degrades honestly — *"I'd need your Mac awake to read that thread"* — while every
metric-based question still works.

This is **not** strictly better than Pally — it is a deliberate trade:

| | Boi (derived-only + `ask_device`) | Pally (history in R2) |
|---|---|---|
| Relationship questions, Mac off | ✅ | ✅ |
| Content questions, Mac **on** | ✅ | ✅ |
| **Content questions, Mac off** | ❌ | ✅ |
| Raw messages sitting on a server | **never** | yes |
| Breach exposes | derived metrics | everyone's actual conversations |

You give up one capability and gain one property. Whether that's the right trade is a
**positioning decision, not an engineering one** — see §5A.1.

### Tradeoffs, stated plainly

### 5A.1 The real fork: what leaves the device

Four options. Pick one consciously — this is the decision the whole product posture hangs on.

1. **Derived-only** (today's contract). Content questions require the Mac awake. Strongest
   possible claim: *"your messages never leave your Mac."* Costs the Mac-off content case.
2. **Export content like Pally.** Full capability parity, no claim. You become custodian of
   your users' conversations — and of their *contacts'* conversations, who never agreed to
   anything.
3. **Export content encrypted to the user's own keys.** Cloud stores, cannot read. Gives you
   durable backup and multi-device, but **not** Mac-off content answering — the agent can't
   read it either. Solves a different problem than the one at hand.
4. **Bounded export.** Only the user's *own* sent messages, only a recent window, plus derived
   summaries of counterpart text. Partial capability, a claim that still survives, and it
   respects the existing asymmetry: the user consented, their contacts didn't.

**My recommendation is 1, with 4 as the pragmatic fallback** if Mac-off content questions turn
out to matter in real usage. Note 4 preserves the property that actually distinguishes you —
you never hold other people's words — while recovering most of the capability. Decide from
usage data, not in advance.

### 5A.2 Derived-only: measured tradeoffs

Numbers from one real account (420 relationships):

```
mirror.db (full content) 43.9 MB      digest_v2 (derived) 1.15 MB     38× smaller
voice exemplars 4,617 — user-authored only, avg 11 per relationship
relationships with ZERO exemplars ........ 164 of 420  (39%)
relationships with an open_thread .........  37 of 420  ( 9%)
```

**Latency — derived is *faster*, not slower, for the questions it can answer.** A
relationship question is a SQL query over normalized rows (~50 ms). Pally must do retrieval
over a message corpus — embed, search, rank, stuff context — before the model sees anything.
Boi hands the model a computed number; they hand it a pile of text and hope it infers the
same thing. Derived-only wins the common case on latency, cost, *and* consistency.

The inversion is content questions: derived-only needs `ask_device` (1–3 s, Mac must be
awake) where Pally does another cloud lookup.

**Depth — strong at relationship level, weak at conversation level.** The line is sharp:

| Question | Derived-only |
|---|---|
| Who's waiting / drifting / overdue | ✅ better than raw — precomputed and calibrated |
| How do I talk to this person | ✅ voice exemplars, where they exist |
| What did I promise | ✅ *if* `open_loops` is built (extraction is on-device) |
| What did Maya say about the trip | ❌ no counterpart prose exists, anywhere |
| Summarize last week with Dan | ❌ |
| Draft a reply to her question | ⚠️ **degraded — the crux** |

Drafting is the case that decides this. Boi has a ≤140-char *derived description* of what
they asked; Pally has the actual sentence. That gap shows up directly in draft quality, and
drafting is a headline use case for both products.

And the exemplar coverage is thinner than the average suggests: **39% of relationships have
no voice sample at all**, so for those contacts the cloud agent holds metrics and literally
zero text.

**Storage is not the constraint.** 43.9 MB × 100k users ≈ 4.4 TB ≈ **~$66/month** on R2, with
free egress. What full export actually costs is the promise, the breach surface, and the
embedding spend to make a corpus searchable — none of which appear on the storage line.

### 5A.3 Reversibility — a two-way door in code, a one-way door in public

**Technically: easy, and nothing is lost by waiting.** The Mac keeps the complete
`MirrorDatabase` forever. Content export is *additive* — a new upload path beside the digest,
no contract change, backfillable from the mirror on any future day. Deciding this in six
months costs you the feature in the meantime and nothing else.

**Commercially: near-irreversible in one direction.** "Your messages never leave your Mac" is
a promise you can only break once. Reversing it needs re-consent from every existing user and
reads as a betrayal regardless of how it's handled. The asymmetry is the whole point:

> derived-only → full export is cheap in code and expensive in trust.
> full export → derived-only is impossible; you cannot un-ship the claim.

Two lock-ins to watch for beyond the promise: agent tools written against a content index are
hard to unwind, and holding conversations raises deletion and disclosure obligations that
don't shrink back.

**Therefore: start derived-only.** It is the only option that preserves the choice. Instrument
which questions fail for lack of content, and let real usage decide — that data does not exist
yet, and picking now means guessing.

If drafting quality turns out to be the binding constraint, the narrow fix beats full export:
**store only the single counterpart message being replied to, only while the loop is open,
deleted on reply.** That is 37 messages for this account rather than 43.9 MB, it fixes the
one case that matters, and the promise survives with an honest asterisk.

| Dimension | Cloud agent (recommended) | On-device (Pally) |
|---|---|---|
| Mac asleep | works (content depends on §5A.1 choice) | works — content is in their cloud |
| Raw message exposure | none under option 1 | uploaded to R2 |
| Iteration speed | deploy in minutes | app release + adoption lag |
| Evals / observability | centralized, real | per-device, hard |
| Security blast radius | ordinary web service | shell-capable agent on a machine full of private messages |
| Inference cost | yours | also theirs |
| Cold-start latency | none | daemon must be running |
| Failure mode | you see it | you don't |

The observability point is underrated: with a cloud agent you can measure hallucination
rate, tool-call accuracy, and latency across all users and fix regressions the same day. On
device, a bad prompt ships and you find out from support tickets.

The honest cost: **you hold derived personal data.** Your existing per-user salt, hash
partitioning, and catalog-verified cascade delete already carry this weight. Don't loosen
them.

---

## 5B. Fluidity and speed — what Tomo gets right

Tomo's transcript shows the target feel: short bubbles, several in a row, conversational,
ending with a question back. It reads instant. Three mechanisms produce that, and **you
already have all three**:

**1. Typing indicator on receipt.** `SpectrumChannel.capabilities()` already declares
`typing: true`. Fire it the moment the webhook lands, before any model call. Perceived
latency drops to near zero while real work continues.

**2. Multi-bubble, progressively delivered.** `outbound.v1` already carries a **`blocks`
array**, and `blocksToParts` already splits it. So instead of one 1,000-character paragraph
after 3 seconds, send bubble one at ~700 ms and the rest as they're ready. Same total time,
completely different feel. iMessage can't stream tokens — but it *can* stream messages, and
that is the closest available equivalent.

**3. Conversational close.** Tomo ends turns with a question. Cheap, and it's the difference
between a lookup tool and something people talk to.

### Latency budget to design against

| Path | Target | How |
|---|---|---|
| Typing indicator | < 200 ms | fire on webhook receipt, before routing |
| Common question (precomputed) | < 800 ms | **cache-first: answer without an agent turn** |
| Novel question, cloud tools only | < 2.5 s | fast model, single tool round-trip |
| Content question needing the Mac | < 5 s | `ask_device`, with an interim bubble |

**Cache-first is the big architectural idea.** After each sync, precompute answers to the
handful of questions people actually ask — who's waiting, who am I drifting from, what's
overdue, the morning brief. Serve those from a materialized table in under a second with **no
agent turn at all**. The agent handles the long tail. This is simultaneously the fastest and
the cheapest design, and it only works if the precompute happens at sync time — which is why
it belongs in the schema now, not later.

---

## 6. Sequence

**Spike first — half a day, before committing to anything.** Write a throwaway app that
`NSOpenPanel`s `~/Library/Messages`, reads `chat.db`, persists a bookmark, quits, relaunches,
resolves, reads again. Then run it from a LaunchAgent. If that passes on your minimum macOS,
§1.1 is real. If it doesn't, you have lost half a day instead of a week.

| Order | Item | Effort | Why here |
|---|---|---|---|
| 0 | FDA spike | 0.5d | de-risks the biggest item |
| 1 | Fix/revert DotEnv, unblock Swift tests | 0.5d | 4 tests red right now |
| 2 | **Moat schema** — `outcomes`, `memories`, `corrections`, `draft_edits` | **3d** | **every day late = unbackfillable signal lost (§5.2)** |
| 3 | NSOpenPanel + bookmarks | 2–4d | biggest onboarding + dev-loop win |
| 4 | Keychain credentials | 1–2d | pairs naturally with 3 |
| 5 | Sparkle + universal binary | 2d | stops manual redistribution |
| 6 | Conversation-first pairing | 3–5d | kills the identity-split class |
| 7 | Data path: batch insert, enqueue ingest, **chat reads SQL not JSONB**, payloads → R2 | ~1w | must precede tools, or they bake in the 1.2 MB read |
| 8 | Typing indicator + multi-bubble delivery | 1d | perceived latency, near-free (§5B) |
| 9 | Precomputed answer cache | ~3d | sub-second common questions, no agent turn |
| 10 | Contract codegen | ~1w | kills the drift class |
| 11 | Router + cloud agent + verifier | ~2w | fluidity, grounded |
| 12 | `ask_device` retrieval | ~1w | content questions without breaking the privacy contract |

Item 2 moved to the front deliberately. It is three days, it blocks nothing, and it is the
only item on this list that gets *permanently* more expensive the longer it waits — the
others can be done late at the same cost. Items 0–6 are ~2 weeks and remove essentially all
the friction burning your time; 7–12 are the following month.

**Immediate, independent of all of the above**: your dev loop is regranting FDA because
re-signing changes the bundle identity TCC keys on. Pin a stable dev bundle path and a
consistent signing identity, and the grant survives rebuilds. That alone gives you back
hours this week.

---

## 6A. Best-in-class checklist

What "best in class" concretely means here, and where you'd stand:

| Property | Target | Pally | Boi today | Boi after this plan |
|---|---|---|---|---|
| Answers anything | ✅ | ✅ | ❌ one question | ✅ |
| Feels instant | < 1 s perceived | ✅ | ~2 s, one bubble | ✅ typing + cache-first |
| Never invents facts about people | ✅ | ❌ no verifier | ✅ by templating | ✅ by verification |
| Works with Mac closed | ✅ | ✅ (content in R2) | ✅ | ✅ (content per §5A.1) |
| Raw messages stay on device | ✅ | ❌ uploaded to R2 | ✅ | ✅ via `ask_device` |
| Onboarding without System Settings | ✅ | ✅ | ❌ FDA | ✅ bookmarks |
| Improves from use | ✅ | partial | ❌ nothing recorded | ✅ outcome ledger |
| Auditable — "why did you say that?" | ✅ | ❌ | n/a | ✅ evidence receipts |
| Sends as the user | ✅ | ✅ | ❌ | ✅ with approval |

The row nobody else can check is **"improves from use."** Pally's page claims knowledge that
"compounds over time," but compounding requires recording outcomes, and outcomes only exist
where the assistant acted and something followed. Same asset as §5.2 — which is why it's item
2 in the sequence, not item 12.

**Evidence receipts** deserve their own note. Once the verifier maps every claim to a tool
result, *"why do you think that?"* is free — the mapping already exists. It turns your
anti-hallucination machinery from an invisible constraint into the most visible trust feature
in the category, and it's the one thing an ungrounded agent cannot retrofit without first
building your entire verification layer.

---

## 7. Honest unknowns

- **Does the NSOpenPanel grant actually cover `~/Library/Messages` on your minimum macOS,
  non-sandboxed, and survive into a LaunchAgent-launched process?** Pally ships it on 13+,
  so it works for them, but I have not verified it and Apple has changed this area
  repeatedly. §6 exists precisely because I will not assert it from a strings dump.
- **How Pally handles the stale-Mac case** (closed laptop, Messages not running) is not
  visible statically. Their UI admits the dependency; the failure mode is unknown.
- **Their permission-server policy** — whether `Bash` is truly reachable from an inbound
  text or gated to a safe subset — cannot be determined without running the app, which I
  did not do.
- **Their cost model.** A 127 MB agent per user implies meaningful per-message inference
  spend. If they're subsidizing, their pricing may not survive scale — but that's inference,
  not evidence.
