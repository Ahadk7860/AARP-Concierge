# From here to the vision — the holes, in priority order

**Vision**: natural-language conversation about your relationships, grounded in real data,
that cannot fabricate facts about people.

**Where we are**: the agent path is live and genuinely working — router classifies, tools
run, verifier checks, honest degradation when there is nothing to say. What is missing is
**data reaching the tools** and **a router willing to route**.

Evidence from production logs, not inference:

```
agent_router_decision lane="agent"
agent_tool_call tool="drifting"        ok=true evidence_count=0
agent_tool_call tool="open_loops"      ok=true evidence_count=0
agent_tool_call tool="search_messages" ok=true evidence_count=0
agent_tool_call tool="memory_search"   ok=true evidence_count=0
agent_verifier_outcome status="verified"
agent_router_refused kind_value="refuse" output_keys="kind"
```

Every tool succeeds and returns nothing. The verifier then correctly has nothing to ground,
so the reply is an honest "I checked and found none." That is the machine working perfectly
over an empty database.

---

## H1 — Every relationship tool returns zero (BLOCKING)

`drifting`, `open_loops`, `relationship_state`, `circle` all return `evidence_count=0`.

`PostgresAgentStore` reads the v3 person-keyed tables. `derive-v3` runs on every ingest and
has never logged a failure — but "did not throw" is not "wrote rows". Nothing counts them.

**Cause is one of**: derivation writes zero rows; it writes rows the store's queries do not
match; or it writes under a different `user_id` scope.

**Fix**: log row counts from `deriveV3FromDigest`, and log what `PostgresAgentStore` gets
back. One sync then says which.

**Until this is fixed nothing else matters.** A perfect router over an empty database still
says nothing.

---

## H2 — The router refuses questions it should route

`who is ahad khot` → `refuse`. `what's the weather in ny` → `refuse`. Both are clean parses;
the model chose refuse.

The first should be `agent` → `relationship_state`. The second should be `agent` → `general`.

**Fix**: the router prompt is too conservative. I3 says *uncertainty* routes to refuse — it
does not say "refuse anything not obviously a cache hit". Refuse should mean genuinely
unanswerable or unsafe, not merely unfamiliar. Widen the prompt, and extend the router eval
corpus with these exact failures so a regression is a test failure.

---

## H3 — Device search can never work

`search_messages` returns 0 because `attachDeviceGateway` has **no call site in `main.ts`**.
The cloud has no WebSocket link to the Mac, so `ask_device` cannot reach the FTS index that
answers in 1–2 ms over 97,137 messages.

**Fix**: wire the gateway into `main.ts`, and the Mac-side client into `BoiApp`. Track C
built and tested both halves; only the plumbing is missing.

**This is the killer feature.** "What did Ahad say about the trip" is the demo.

---

## H4 — `general` answers always degrade

Any capitalized word reads as a name claim, and `general` deliberately grounds zero name
claims — so "New York" trips it. The user still gets the text via a passthrough, but it
costs an escalation round-trip and reads as `degraded`.

**Fix**: allow `general` to ground name-shaped tokens **only** in turns where no
person-scoped tool ran. A pure general-knowledge turn has no relationship data to corrupt.
Keep the adversarial test that proves a `general` answer cannot assert a relationship fact.

---

## H5 — The cache lane never hits

`precomputeAll` has zero callers, so `precomputed_answers` is never populated and every
`cache_hit` falls through to the agent. Correct, but the <800 ms path is dead.

**Fix**: call `precomputeAll` after a successful ingest, invalidate on new data.

---

## H6 — A job stuck in `running` is lost forever

`dequeue` only takes `pending`. A worker that dies mid-job orphans that digest permanently —
no retry, no alert. It already happened once today; the data survived only because the user
synced again.

**Fix**: lease timeout. Any job in `running` past a threshold returns to `pending`.

---

## H7 — Sync is a full recompute

~100 s per sync even when zero new messages arrive, because all 423 relationships are
rebuilt from all 98,000 messages every time. The redaction fix took this from 15 minutes to
100 seconds; it did not make it incremental.

**Fix**: the ported derivation was designed for rolling updates per interaction. Needs Track
I merged, timezone wired, and content upload enabled.

---

## H8 — Timezone blocks derivation cutover

Swift reads `Calendar.current`; the cloud defaults to UTC. Measured: **28 of 420
relationships (6.7%) reclassify**. The `users` table has the column; the Mac does not send it
and derivation does not use it.

---

## Order of work

| # | Hole | Why this order |
|---|---|---|
| 1 | **H1** data reaching tools | Everything else is cosmetic without it |
| 2 | **H2** router willing to route | Cheap, immediately visible |
| 3 | **H3** device search wired | The killer feature |
| 4 | **H4** general answers cleanly | Completes "ask me anything" |
| 5 | **H6** job lease | Silent data loss |
| 6 | **H5** precompute | Latency, not capability |
| 7 | **H8 → H7** timezone, then cutover | Weeks; unblocks incremental sync |

---

## How to know it is real

Not "tests pass". These, against production:

1. `who is Ahad Khot` returns a real relationship summary
2. `what did Chris Dodla say about X` returns a real message snippet
3. `who am I drifting from` names actual people
4. `what's the weather in NY` answers, honestly caveated, without degrading
5. No `evidence_count=0` on a question that should have evidence

Each is checkable from the logs plus the reply. Anything less is not the vision.
