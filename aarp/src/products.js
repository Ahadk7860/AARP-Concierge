// Product discovery — PRD §12. Exa is the research layer when EXA_API_KEY is set;
// until then a curated demo catalog of ordinary retail goods (§28) keeps the loop
// runnable. Both return the same shape; the agent never sees which rail answered
// except via `source`.
const EXA_KEY = () => process.env.EXA_API_KEY || "";

const DEMO_CATALOG = [
  { name: "Personalized gymnastics gym bag", price: 37, merchant: "Things Remembered", category: "gifts kids sports gymnastics bag",
    url: "https://www.thingsremembered.com/", aarp_benefit: "flowers-gifts", discount_pct: 20 },
  { name: "Gymnastics activity play set", price: 42, merchant: "Fat Brain Toys", category: "gifts kids toys gymnastics activity",
    url: "https://www.fatbraintoys.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Craft & jewelry making kit", price: 29, merchant: "Michaels", category: "gifts kids crafts arts",
    url: "https://www.michaels.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "LEGO building set (ages 6-10)", price: 45, merchant: "Target", category: "gifts kids toys lego building",
    url: "https://www.target.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Soccer training ball + cones set", price: 34, merchant: "Dick's Sporting Goods", category: "gifts kids sports soccer",
    url: "https://www.dickssportinggoods.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Basketball indoor/outdoor official size", price: 30, merchant: "Dick's Sporting Goods", category: "gifts kids teens sports basketball",
    url: "https://www.dickssportinggoods.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Science experiment mega kit", price: 39, merchant: "Fat Brain Toys", category: "gifts kids toys science STEM",
    url: "https://www.fatbraintoys.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Birthday flower bouquet (seasonal)", price: 49, merchant: "Food & Gifts by FTD", category: "flowers gifts birthday anniversary spouse",
    url: "https://www.ftd.com/", aarp_benefit: "food-gifts-by-ftd", discount_pct: 25 },
  { name: "Gourmet chocolate gift box", price: 36, merchant: "Food & Gifts by FTD", category: "gifts food chocolate sweets",
    url: "https://www.ftd.com/", aarp_benefit: "food-gifts-by-ftd", discount_pct: 25 },
  { name: "Cozy fleece throw blanket", price: 32, merchant: "Target", category: "gifts household home cozy",
    url: "https://www.target.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Wireless earbuds (budget pick)", price: 49, merchant: "Walmart", category: "gifts electronics teens music",
    url: "https://www.walmart.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Golf practice net + mat", price: 55, merchant: "Dick's Sporting Goods", category: "gifts golf sports hobby",
    url: "https://www.dickssportinggoods.com/", aarp_benefit: null, discount_pct: 0 },
  { name: "Gardening tool gift set", price: 38, merchant: "Ace Hardware", category: "gifts gardening hobby household",
    url: "https://www.acehardware.com/", aarp_benefit: null, discount_pct: 0 },
];

function scoreDemo(p, tokens, budget) {
  const hay = (p.name + " " + p.category + " " + p.merchant).toLowerCase();
  let s = tokens.filter((t) => hay.includes(t)).length;
  if (budget && p.price <= budget) s += 0.5;
  if (budget && p.price > budget * 1.3) s -= 2;
  if (p.aarp_benefit) s += 0.4;
  return s;
}

async function exaSearch(query, budget) {
  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": EXA_KEY() },
    body: JSON.stringify({ query: `${query} buy online${budget ? ` under $${budget}` : ""}`,
      numResults: 6, type: "auto", contents: { text: { maxCharacters: 400 } } }),
  });
  if (!r.ok) throw new Error(`exa ${r.status}`);
  const d = await r.json();
  return (d.results || []).map((x) => {
    // best-effort price from page text — the agent must NEVER invent one
    const m = /\$\s?(\d{1,4}(?:\.\d{2})?)/.exec(x.text || "");
    return {
      name: (x.title || "").trim().slice(0, 90),
      price: m ? Number(m[1]) : null,
      price_note: m ? "extracted from page — verify at checkout" : "price not visible — do NOT guess; ask the member or pick an option with a price",
      merchant: new URL(x.url).hostname.replace(/^www\./, ""),
      url: x.url, snippet: (x.text || "").replace(/\s+/g, " ").slice(0, 200), source: "exa",
    };
  });
}

/** Same shape either way: [{name, price, merchant, url, discount_pct?, source}] */
export async function searchProducts({ query, budget = null, limit = 4 }) {
  if (EXA_KEY()) {
    try {
      const results = await exaSearch(query, budget);
      if (results.length) return { source: "exa", products: results.slice(0, limit) };
    } catch { /* fall through to demo catalog */ }
  }
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const ranked = DEMO_CATALOG
    .map((p) => ({ p, s: scoreDemo(p, tokens, budget) }))
    .filter((x) => x.s > 0.4)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => ({ ...x.p, source: "demo" }));
  return { source: EXA_KEY() ? "demo-fallback" : "demo",
    note: EXA_KEY() ? undefined : "Demo catalog (Exa not configured yet) — real product research activates with EXA_API_KEY.",
    products: ranked };
}
