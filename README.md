# AARP Concierge

An AI personal benefits concierge for AARP members, living in iMessage. Text it before
you spend — dinner, travel, shopping — and it finds what your membership can do, learns
what you care about, and proactively surfaces value over time. Full spec: [PRD.md](PRD.md).

**Live:** https://aarp-concierge-production.up.railway.app (onboarding page) ·
`/dashboard` (analytics) · `/health`

| Path | What |
|---|---|
| `aarp/src/` | The product: agent, benefits engine, memory, proactive intelligence, Photon iMessage loop, HTTP bridge + onboarding |
| `aarp/ingestion/` | Python catalog ingester (the JS refresher in `src/refresh.js` runs daily in prod) |
| `aarp/data/benefits.json` | Normalized AARP benefit catalog (baked fixture; refreshed on the volume in prod) |
| `aarp/test/` | Offline tests — `npm test`, no network, no keys |

See [aarp/README.md](aarp/README.md) for the module map and run commands.

Prototype demo built on public AARP benefit listings — not an official AARP product.
