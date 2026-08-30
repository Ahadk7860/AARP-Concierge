# AARP Concierge — P0 track

The AARP iMessage benefits concierge ([PRD.md](../PRD.md)). This track is the new
product layer; it reuses Boi's delivery spine (`cloud/channel`, `cloud/inbound`) when
wired to Photon, per [IMESSAGE_AGENT_PLAYBOOK.md](../IMESSAGE_AGENT_PLAYBOOK.md).

## What's here

| Path | What | PRD |
|---|---|---|
| `ingestion/ingest_benefits.py` | Scraper/API client for the AARP catalog — A-Z page cards + the structured `ws.api/offers/<category>.json` feeds + per-offer AEM dataview fallback. Normalizes, requires outlinks, diffs against the previous run. | §5-6 |
| `data/benefits.json` | The normalized catalog (303 benefits, 25 categories, 100% with outlinks). Committed as the demo/test fixture; refresh daily in production. | §5 |
| `src/benefits.js` | Catalog load, intent→category mapping, search + BenefitScore ranking, brand dedup. | §7, §30 |
| `src/memory.js` | Member memory store — profile/behavioral/episodic memories with confidence, reinforcement, expiry, forget; trips, watches, saved benefits, interactions, savings. JSON-per-member for P0; same interface swaps to Postgres at pilot. | §8-12, §43 |
| `src/agent.js` | The concierge: persona, tool specs (search/remember/forget/trips/watches/save/savings), Anthropic tool loop (`claude-sonnet-5`) + deterministic `fake` provider for offline tests. | §40, §42, §44 |
| `src/proactive.js` | Proactive sweep: watches + trips + temporal moments × memory → candidates → interruption score → frequency cap (7d) + subject cooldown (30d) + repeat suppression. Most sweeps send nothing, by design. | §15-16, §31-33, §45 |
| `src/demo.js` | Exec-demo harness with **simulated dates** to prove persistence (§49). |
| `test/` | `node --test aarp/test/*.test.js` — 11 offline tests, no network, no key. |

## Run it

```bash
# refresh the catalog (network)
python3 aarp/ingestion/ingest_benefits.py

# tests (offline)
node --test aarp/test/*.test.js

# live agent (needs ANTHROPIC_API_KEY)
node aarp/src/demo.js --member you --date 2026-08-30 "going to outback tonight"

# interactive, with date jumps
node aarp/src/demo.js --member you
#   /date 2026-11-20   /profile   /reset   /quit

# proactive sweep for a member at a simulated date
node aarp/src/demo.js --member you --date 2026-11-20 --proactive

# offline demo without a key
node aarp/src/demo.js --member you --provider fake --date 2026-08-30 "dinner tonight"
```

## Exec demo arc (verified offline)

1. `2026-08-30` — "going to outback tonight" → Outback 10% + redemption link.
2. Member mentions grandkids/toys and Hawaii winters → memories stored (live agent
   extracts these itself via the `remember` tool).
3. "keep an eye out for Hawaii deals" → watch created.
4. `2026-09-25` sweep → Hawaii watch fires once (then 30-day subject cooldown).
5. `2026-12-06` sweep → Christmas moment fires: *"…I remembered: grandkids are obsessed
   with toys — Food & Gifts by FTD: 25% off…"*
6. "what do you remember about me?" → plain list + how to forget.
7. "how much have I saved?" → savings tracker total.

## Not built yet (P0 gaps)

- **Source 2 (memberoffers.aarp.org local restaurants)** — the offerwall is a client-side
  Augeo widget; its API needs a browser-session capture to reverse. National restaurant
  chains are already in the main catalog.
- **Photon wiring** — the agent's `converse(memberId, text, {now})` is the seam; connect
  it behind `cloud/inbound/router.ts` (idempotency) + `cloud/channel` once Photon
  credentials for the AARP line exist.
- **ZIP/proximity search, screenshot search, Rewards** (mock data only), member auth.
