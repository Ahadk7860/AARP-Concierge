// Product discovery — AARP-DISCOUNT MERCHANTS ONLY.
//
// The rule: a product may only be recommended if it lives on a merchant where the
// member's AARP benefit applies. Flow: query → match AARP benefits → collect their
// partner domains → Exa search RESTRICTED to those domains (includeDomains) → attach
// the benefit (discount %) to each result. get_product_details() then scrapes one
// chosen page via Exa /contents for price/description before checkout.
import { loadCatalog } from "./benefits.js";
import { blockedCategory } from "./purchases.js";

const EXA_KEY = () => process.env.EXA_API_KEY || "";

const PRODUCT_CATS = new Set(["shoppingandgroceries", "entertainment", "home-tech",
  "travel", "restaurants", "healthandwellness", "autoservice"]);

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
}

/** AARP benefits whose partner sites are eligible for this query. */
export function aarpMerchantsFor(query, limit = 6) {
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const out = [];
  for (const b of loadCatalog().benefits) {
    const domain = domainOf(b.outlink_url);
    if (!domain || domain.includes("aarp")) continue;
    if (!PRODUCT_CATS.has(b.category)) continue;
    if (blockedCategory(`${b.brand} ${b.title} ${b.keywords.slice(0, 6).join(" ")}`)) continue; // no alcohol etc.
    const hay = (b.brand + " " + b.title + " " + b.keywords.join(" ") + " " + b.category).toLowerCase();
    let s = tokens.filter((t) => hay.includes(t)).length;
    // generic gift/shopping intent gets the gift-capable merchants
    if (/gift|present|flower|birthday|christmas|holiday|anniversary|shopping|buy/.test(query.toLowerCase())
        && ["shoppingandgroceries", "entertainment"].includes(b.category)) s += 1;
    if (b.discount_type === "percentage" && b.discount_value >= 15) s += 0.5;
    if (s > 0.5) out.push({ domain, brand: b.brand, benefit_id: b.id, category: b.category,
      discount_type: b.discount_type, discount_pct: b.discount_type === "percentage" ? b.discount_value : null,
      benefit_title: b.title, redemption_url: b.redemption_url, score: s });
  }
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score)
    .filter((m) => !seen.has(m.domain) && seen.add(m.domain))
    .slice(0, limit);
}

function extractPrice(text) {
  const m = /\$\s?(\d{1,4}(?:\.\d{2})?)/.exec(text || "");
  return m ? Number(m[1]) : null;
}

async function exa(path, body) {
  const r = await fetch("https://api.exa.ai/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": EXA_KEY() },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`exa ${r.status}`);
  return r.json();
}

// Demo fallback (Exa down/unset): AARP-benefit merchants only.
const DEMO = [
  { name: "Birthday flower bouquet (seasonal)", price: 49, domain: "ftd.com", category: "flowers gifts birthday anniversary spouse" },
  { name: "Gourmet chocolate & sweets gift box", price: 36, domain: "ftd.com", category: "gifts food chocolate sweets birthday" },
  { name: "Fruit & snack gift basket", price: 42, domain: "ftd.com", category: "gifts food basket holiday" },
  { name: "Mixed rose bouquet with vase", price: 45, domain: "proflowers.com", category: "flowers gifts anniversary spouse romantic" },
  { name: "Succulent garden gift set", price: 38, domain: "proflowers.com", category: "gifts plants household gardening" },
  { name: "Live event tickets (local sports/shows)", price: 40, domain: "gofevo.com", category: "gifts entertainment tickets family outing kids teens" },
  { name: "Ancestry family history kit (6-month)", price: 44, domain: "ancestry.com", category: "gifts hobby family history grandparent" },
];

/**
 * AARP-only product search. Every result carries the AARP benefit that applies.
 * Returns {merchants, products, note?}.
 */
export async function searchProducts({ query, budget = null, limit = 5 }) {
  const merchants = aarpMerchantsFor(query);
  if (!merchants.length) {
    return { merchants: [], products: [],
      note: "No AARP-discount merchant matches this request. Say so honestly and suggest the closest AARP-eligible category — never recommend a non-AARP merchant." };
  }
  const byDomain = Object.fromEntries(merchants.map((m) => [m.domain, m]));
  const attach = (domain) => {
    const m = byDomain[domain]
      || merchants.find((x) => domain && (domain === x.domain || domain.endsWith("." + x.domain)))
      || null;
    return m ? { aarp_brand: m.brand, aarp_benefit_id: m.benefit_id, aarp_discount_pct: m.discount_pct,
      aarp_benefit: m.benefit_title, aarp_redemption_url: m.redemption_url } : {};
  };

  if (EXA_KEY()) {
    try {
      const d = await exa("search", {
        query: `${query}${budget ? ` under $${budget}` : ""}`,
        numResults: Math.min(limit * 2, 10), type: "auto",
        includeDomains: merchants.map((m) => m.domain),
        contents: { text: { maxCharacters: 500 } },
      });
      const products = (d.results || []).map((x) => {
        const domain = domainOf(x.url);
        const price = extractPrice(x.text);
        const meta = attach(domain);
        return { name: (x.title || "").trim().slice(0, 90), price,
          price_note: price ? "extracted from page — verify with get_product_details before checkout"
            : "price not visible — call get_product_details on this url before proposing",
          merchant: meta.aarp_brand || domain, url: x.url,
          snippet: (x.text || "").replace(/\s+/g, " ").slice(0, 180),
          ...meta, source: "exa" };
      }).filter((p) => p.name && !blockedCategory(p.name));
      if (products.length) return { merchants: merchants.map(({ score, ...m }) => m), products: products.slice(0, limit) };
    } catch { /* fall through */ }
  }
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const products = DEMO
    .filter((p) => byDomain[p.domain])
    .map((p) => ({ p, s: tokens.filter((t) => (p.name + " " + p.category).toLowerCase().includes(t)).length
      + (budget && p.price <= budget ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s)
    .filter((x) => x.s > 0)
    .slice(0, limit)
    .map((x) => ({ name: x.p.name, price: x.p.price, merchant: byDomain[x.p.domain].brand,
      url: `https://www.${x.p.domain}/`, ...attach(x.p.domain), source: "demo" }));
  return { merchants: merchants.map(({ score, ...m }) => m), products,
    note: EXA_KEY() ? "Exa unavailable — demo items from AARP merchants." : "Demo items (Exa not configured)." };
}

/** Scrape ONE product page (AARP partner domains only) for details before checkout. */
export async function getProductDetails(url) {
  const domain = domainOf(url);
  if (!domain) return { error: "invalid url" };
  const partnerDomains = new Set(loadCatalog().benefits.map((b) => domainOf(b.outlink_url)).filter(Boolean));
  if (![...partnerDomains].some((d) => domain === d || domain.endsWith("." + d)))
    return { error: `${domain} is not an AARP partner merchant — only AARP-discount merchants are eligible.` };
  if (!EXA_KEY()) return { error: "Exa not configured — cannot scrape product pages." };
  try {
    const d = await exa("contents", { urls: [url], text: { maxCharacters: 2000 } });
    const r = (d.results || [])[0];
    if (!r) return { error: "page could not be read" };
    const text = (r.text || "").replace(/\s+/g, " ");
    const prices = [...text.matchAll(/\$\s?(\d{1,4}(?:\.\d{2})?)/g)].map((m) => Number(m[1])).slice(0, 6);
    return { url, title: (r.title || "").slice(0, 120),
      prices_seen: prices, best_price_guess: prices.length ? Math.min(...prices.filter((p) => p >= 5)) || prices[0] : null,
      details: text.slice(0, 1200),
      note: "Use a price the page actually shows. If none is clear, tell the member you couldn't confirm the price." };
  } catch (e) { return { error: `scrape failed: ${e.message}` }; }
}
