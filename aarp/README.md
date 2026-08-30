# AARP Concierge — P0 track

The AARP iMessage benefits concierge ([PRD.md](../PRD.md)). Self-contained: the only
runtime dependency is the `@spectrum-ts` SDK for the Photon iMessage line.

## What's here

| Path | What | PRD |
|---|---|---|
| `ingestion/ingest_benefits.py` | Scraper/API client for the AARP catalog — A-Z page cards + the structured `ws.api/offers/<category>.json` feeds + per-offer AEM dataview fallback. Normalizes, requires outlinks, diffs against the previous run. | §5-6 |
| `data/benefits.json` | The normalized catalog (303 benefits, 25 categories, 100% with outlinks). Committed as the demo/test fixture; refresh daily in production. | §5 |
| `src/benefits.js` | Catalog load, intent→category mapping, search + BenefitScore ranking, brand dedup. | §7, §30 |
| `src/memory.js` | Member memory store — profile/behavioral/episodic memories with confidence, reinforcement, expiry, forget; trips, watches, saved benefits, interactions, savings. JSON-per-member for P0; same interface swaps to Postgres at pilot. | §8-12, §43 |
| `src/agent.js` | The concierge: persona, tool specs (search/remember/forget/trips/watches/save/savings), Anthropic tool loop (`claude-sonnet-5`) + deterministic `fake` provider for offline tests. | §40, §42, §44 |
| `src/proactive.js` | Proactive sweep: watches + trips + temporal moments × memory → candidates → interruption score → frequency cap (7d) + subject cooldown (30d) + repeat suppression + muted-category filter. Most sweeps send nothing, by design. | §15-16, §31-33, §45 |
| `src/local_restaurants.js` | **Source 2, live** — reverse-engineered Augeo/Kigo offerwall: scrape the per-render anonymous token from memberoffers.aarp.org, send it raw as `Authorization` to `offersv2-api.p.augeocms.com/api/v2/kigo/offers?postalCode=…`. Queried live per ZIP with keyword + distance; token cached 30 min, re-scraped on 401. | §5, §21 |
| `src/rewards.js` | AARP Rewards conversational surface — balance, expiring points, preference-ranked redemptions, earning activities. Mock data behind the real interface (swap at pilot). | §23-25 |
| `src/server.js` | The Photon seam: HTTP bridge (`POST /inbound`, `POST /sweep`, `GET /health`) with message-id dedupe (at-least-once inbound) and per-member turn serialization. | §41 |
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

## Agent tools (16)

search_benefits · search_local_restaurants (live, ZIP + keyword + distance) · remember ·
forget · add_trip · create_watch · remove_watch · save_benefit · record_benefit_used ·
get_savings (incl. goal progress) · set_savings_goal · get_rewards · get_opportunities
("what am I missing?" / "anything good for me?") · mute_category

Member controls honored end-to-end: mute a category (search, ranking, and proactive all
respect it), stop a watch, forget a memory, savings goals.

## Not built yet (P1)

- **Real Rewards API** (mock today) and real AARP member authentication (`/link` is a
  demo stub).
- **Voice-note transcription** — audio attachments are acknowledged but not transcribed.
- **Personalization-lift A/B measurement** (§47/§53) — needs traffic.
