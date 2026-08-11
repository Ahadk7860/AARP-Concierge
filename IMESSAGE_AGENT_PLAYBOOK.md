# Building an iMessage agent without a Mac — everything learned from Boi

**Audience**: an LLM standing up a new product — an agent reachable over iMessage that
answers general queries, calls external APIs, web-searches, and holds a natural-language
conversation. **No Mac app. No Apple permissions. No `chat.db`.**

**Source**: `/Users/skylerluk/Dev/boi-imessage`. File paths below are real; read them.

This is written to save you the two classes of pain that dominated Boi's build: **iMessage
delivery is not the hard part**, and **the hard part is that failures are silent**.

---

## 1. What carries over, and what does not

| Boi component | Take it? |
|---|---|
| `cloud/channel/**` — iMessage send/receive via provider | **Yes.** This is the whole delivery layer |
| `cloud/inbound/router.ts` — inbound routing, idempotency | **Yes.** Hard-won correctness |
| `cloud/agent/**` — router, tools, verifier, loop | **Yes, selectively.** See §5 |
| `cloud/shared/src/contracts.ts` — frozen wire schemas | **Yes.** The discipline more than the content |
| `cloud/db/src/scope.ts`, `catalog.ts` — tenancy + deletion | **Yes.** Rare to get right later |
| `mac/**` — the entire Mac app | **No.** ~6,000 lines you do not need |
| `cloud/db/src/derive-v3.ts`, digest/voice-pack pipeline | **No.** Relationship-specific |
| Full Disk Access, TCC, security-scoped bookmarks, LaunchAgents | **No.** Roughly a third of Boi's total pain |

**Dropping the Mac removes the single largest source of complexity.** Not because the code
is bad, but because macOS permissions are invisible, per-signature, silently denied, and
untestable in CI. If you never touch them, you skip it entirely.

---

## 2. iMessage delivery without a Mac

Boi reaches iMessage through a **third-party provider** (Photon/"Spectrum" in this repo).
The provider owns Apple accounts and the blue-bubble plumbing. You talk HTTP.

Read, in order:
- `cloud/channel/src/spectrum-port.ts` — the injected seam. Everything provider-specific is
  behind it, so the rest of the system never knows who carries messages.
- `cloud/channel/src/spectrum-stream.ts` — inbound events, with resume cursors and
  at-least-once delivery.
- `cloud/channel/src/spectrum-live-send.ts` — outbound.
- `cloud/channel/src/spectrum-signature.ts` — webhook signature verification.
- `cloud/channel/src/line-registry.ts` — which user is on which phone line.

### The four facts that matter

**1. Inbound is at-least-once. Design for duplicates.** Events carry a provider id and an
opaque cursor. You will receive the same message twice. `cloud/inbound/router.ts` handles
this with a canonical-outcome claim: the first processor of an event id wins, and a
duplicate returns the same reply rather than generating a second one. Copy that pattern —
an agent that answers twice is worse than one that answers slowly.

**2. Lines are shared, and a ban is collective.** From `line-registry.ts`:

> *"because lines are shared, one ban takes out every user on that line at the same moment
> — so 'who is affected' has to be answerable instantly."*

Track line health from day one. Keep test traffic on a **separate provider project**, never
a second line in the same one.

**3. Fire the typing indicator before any model call.** Sub-200ms, on webhook receipt,
before routing. A model turn is 1–3 seconds; without it the product feels broken.

**4. Green bubbles are a different medium.** SMS reaches a Mac only via Text Message
Forwarding and has no queue. Without a Mac in the loop this is the provider's problem, not
yours — one more reason to skip the Mac.

---

## 3. The agent loop that works

`cloud/agent/src/` — read `agent-loop.ts`, `router.ts`, `tools.ts`, `verifier.ts`.

```
inbound → typing indicator → router (cheap model)
                               ├── cache_hit → precomputed answer  (<800ms)
                               ├── refuse    → fixed decline
                               └── agent     → tool loop → verifier → deliver
```

### Router lessons, learned the hard way

**Make `agent` the default. Reserve `refuse` for unsafe.** Boi's router prompt said *"if
uncertain, choose refuse, never guess"* — so it refused "who is Ahad Khot" and "what's the
weather". Every question came back as a decline.

The reasoning error is worth internalising: **routing to the agent is not answering.** The
agent looks things up and the verifier checks the result. Refusing an unfamiliar question is
not the safe choice, it is the useless one. See the corrected prompt in `router.ts`.

**Parse defensively and log the raw shape.** `parseRouterOutput` fails closed to `refuse` on
anything unexpected — sensible, but it made "model returned markdown-fenced JSON"
indistinguishable from "model said refuse". Log the output's type and keys (never its text)
on refusal.

**Use a small model for routing and a bigger one for the turn.** Separate env vars even at
identical values — different latency budgets, different blast radii.

---

## 4. Verify your model IDs against the endpoint you actually call

This cost hours. **Read this twice.**

Boi's spec named `gemini-2.5-flash-lite`. Production returned:

```
404 — "This model models/gemini-2.5-flash is no longer available to new users."
```

Worse: I "confirmed" the model existed by probing `/v1beta/models/{id}` — the **native**
API — while the agent called `/v1beta/openai/chat/completions`, the **OpenAI-compatible**
one. Both exist. They disagree. `GET /models` on the compat endpoint *listed* models it
would then 404 on.

**Rules:**
- Confirm a model with the **exact call your code makes** — same base URL, same path, same
  auth header, a real completion. A listing is not a confirmation.
- Model IDs expire. Hard-coded names in a spec written weeks ago are already suspect.
- Google's OpenAI-compat endpoint needs `Authorization: Bearer`; `x-goog-api-key` returns
  400 there. The native endpoint is the reverse.
- On startup, log the model IDs in use. `probeModelIds` in `model-config.ts` is the shape.

---

## 5. The verifier — take it if your agent talks about people

Boi's premise: it **cannot fabricate facts about people**. `verifier.ts` enforces it — every
person-name, handle, date and number in a reply must appear in a tool result **from that
turn**. Violation → one regenerate naming the violation → then degrade to a grounded summary.

**If your agent answers general knowledge only, you may not need this.** If it ever says
something about a real human — a contact, a CRM record, a user's colleague — you do.

Four defects were found in it, and they generalise:

1. **Opaque IDs polluting the evidence pool.** A `person_id` like `p_8f3a12` put `8`, `3`,
   `12` into "supported numbers", so "you have 12 open loops" verified against a hash
   fragment. Fix: bucket evidence by the **key** each value was reached through, never by
   guessing from the value's shape.
2. **Any prose word grounding a name.** The word "trip" in a snippet let "Trip asked about
   the plan" pass. Fix: ground names only against name-bearing fields (`display`), never
   free prose.
3. **Empty draft shipping a blank message.** Guard on the draft alone, and delete the
   fallback that re-emits empty text.
4. **A general-knowledge tool laundering person claims.** If you add a `general` tool, give
   it a distinct evidence source and forbid it from grounding names when any person-scoped
   tool ran in the same turn. There is a test named for this constraint; write yours.

**The ceiling to know about:** this verifies that atoms *appear* in tool output, not that the
asserted *relation* holds. "Sarah owes you a reply" passes whenever "Sarah" appears anywhere.
Write that limit down rather than discovering it.

---

## 6. Contracts, and why they drift

`contracts/schema/*.json` + zod mirrors in `cloud/api/src/schemas.ts` + TS types in
`cloud/shared/src/contracts.ts`.

**Three representations of one contract is three chances to drift.** Boi's answer:
`differential.test.ts` validates fixtures against the JSON Schema (via ajv) *and* the zod
mirror, and a compile-time bidirectional assertion ties the TS type to `z.infer<>`.

Two real failures:

- **`additionalProperties: false` is a landmine.** Adding one field to the heartbeat payload
  rejected the **entire request**, so every device would have 400'd. Caught pre-ship only
  because a test exercised it.
- **A contract nothing consumes is not done.** `chat_reply.v2` was fully schema-validated and
  differential-tested for a day while **nothing imported it**, so verified evidence refs were
  computed and thrown away at the transport boundary. Ship the consumer with the schema.

**Also: a v2 is not necessarily a superset of v1.** Boi's `RelationshipV2` *dropped* eight v1
fields. A downstream consumer assumed superset, guarded on a field that no longer existed,
and silently wrote zero rows for weeks. If you version a payload, state explicitly what was
removed.

---

## 7. Multi-tenancy and deletion — do this at the start

`cloud/db/src/scope.ts` and `catalog.ts` are the best code in the repo.

- **Every query takes a `UserScope`.** `scopedQuery` throws if a query is unscoped or returns
  another user's rows. Not a convention — enforced.
- **Deletion verifies rather than trusts.** `catalog.ts` asks Postgres which tables are
  reachable from `users` by foreign key and **refuses to run** if it finds one it cannot
  count. A hardcoded table list silently stops matching the schema the first time someone
  adds a table, and for deletion a missed table is a regulator's problem.
- **External stores need explicit deletion.** Postgres cascades; S3/R2 does not. Boi shipped
  R2 uploads with `deleteUser` reporting verified success while the bucket kept everything.
  If you add object storage, extend deletion **in the same PR**, and verify the prefix is
  empty afterward.

---

## 8. The lesson that mattered most: silence

Boi is well-built and nearly silent, which is the worst combination. Six bugs in one day
each produced a **plausible wrong answer instead of an error**:

| Symptom | Actual cause |
|---|---|
| "Contacts is broken" | Contacts fine; upload died before sending |
| "Worker isn't running" | Running fine; job orphaned in `running` |
| "The agent can't think" | Real agent wired to an empty store |
| "The router refuses everything" | Model call 404'd inside a bare `catch {}` |
| "Tools return nothing" | Derivation wrote 0 rows and reported success |
| "The fix didn't work" | Build packaged a stale binary |

### Rules to build in from day one

**A bare `catch {}` that returns a default is a bug.** `routeQuestion` swallowed the model
error and returned `refuse`, making a misconfigured provider identical to a working one
declining. If you must fail closed, **log why**.

**"Did not throw" is not "did work".** Log counts, not just completion. `v3_derived
persons=423 interactions=0` found in ten seconds what three hours of reasoning had not.

**Draw the whole chain before fixing anything.** List every place the thing could break —
mutually exclusive, collectively exhaustive — and test each with a command, not a theory.
Boi's contacts bug had five links; three correct fixes landed on links 1–3 while the break
was at 4, then 5. **Fixing the wrong link looks exactly like fixing nothing.**

**When you cannot see inside, ship a log line, not another guess.** Three wrong hypotheses
about one failure means the next commit is instrumentation.

**A contradiction is a gift.** The app reported Contacts "denied" while the OS showed no app
had ever requested it. Both could not be true, and that disagreement pointed straight at the
real cause. When two sources conflict, that conflict is the lead.

**Test with more than one of everything.** Two separate SQL bugs survived every test because
nothing ever called those functions with more than one row. A single row hides an off-by-one
in a placeholder index.

---

## 9. A starting shape for your product

```
inbound (provider webhook/stream)
  → verify signature, fire typing indicator
  → idempotency claim on provider event id
  → router (small model): answer | refuse
  → agent loop with tools:
        web_search        ← you have this, Boi did not
        external APIs     ← your integrations
        memory_read/write ← user-stated facts
        general           ← model knowledge, honestly caveated
  → verifier (only if you assert facts about people)
  → outbound, progressively if the provider allows
  → encrypted turn store, with a retention window
```

Steal directly: `spectrum-port.ts` (provider seam), `router.ts` (idempotency + claim),
`scope.ts`/`catalog.ts` (tenancy + deletion), `agent-loop.ts` (tool loop), the contract
discipline in `differential.test.ts`.

Skip: everything under `mac/`, the digest/voice-pack/derivation pipeline, and the
relationship model.

**One thing Boi never had that you should build first: web search.** Its `general` tool is
model-knowledge only, so it cannot answer "what's the weather" honestly. If "better than a
search engine because it knows you" is the pitch, live retrieval is not a later feature — it
is the product.

**And build observability before features.** Every hour spent on structured logs at the
start would have saved several later. That is the single highest-confidence claim in this
document.
