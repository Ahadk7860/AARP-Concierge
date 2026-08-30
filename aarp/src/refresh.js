// Daily catalog refresh — PRD §6, in-process JS port of aarp/ingestion/ingest_benefits.py.
// Crawls the A-Z page + the ws.api category graph, normalizes with required outlinks,
// diffs against the current catalog, and atomically swaps the file benefits.js reads.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { catalogPath, invalidateCatalog } from "./benefits.js";

const BASE = "https://www.aarp.org";
const AZ_URL = `${BASE}/membership/benefits/all-offers-a-z/`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const SEEDS = ["restaurants", "travel", "entertainment", "insurance", "healthandwellness",
  "shoppingandgroceries", "autoservice", "finances", "caregiving", "community", "magazine",
  "limitedtimememberoffer"];
const STRIP = /(gclid|gbraid|wbraid|fbclid|msclkid|adobe_mc\w*|gclsrc|gad_\w+)=[^&]*&?/g;

const strip = (u) => {
  u = (u || "").replace(STRIP, "").replace(/[?&]$/, "");
  return u.startsWith("/") ? BASE + u : u;
};
const clean = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

async function get(url, type = "json") {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return type === "json" ? r.json() : r.text();
}

function inferDiscount(...texts) {
  for (const t of texts) { const m = /(\d+(?:\.\d+)?)\s*%/.exec(t || ""); if (m) return ["percentage", +m[1]]; }
  for (const t of texts) { const m = /\$\s*(\d+(?:\.\d+)?)/.exec(t || ""); if (m) return ["dollar", +m[1]]; }
  return ["other", null];
}

function normalize(dbr, api, card, now) {
  api = api || {}; card = card || {};
  // URL-safe slug: ids land in redirect links, so lowercase and strip anything
  // that is not [a-z0-9-] (the feed ships "…-Q12026" and one id with an "&").
  const slug = (card.offerid || api.analytics_offerid || dbr)
    .replace(/-\d+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const title = clean(api.offer_title), short = clean(api.offer_short_description);
  const [dt, dv] = inferDiscount(title, short, clean(api.offer_description));
  const page = strip(api.offer_deeplink_url || card.href || "");
  return {
    id: slug, dbr_offer_id: dbr,
    brand: clean(api.source_name || (card.brand || "").split("|").pop()),
    title: title || short, description: clean(api.offer_description),
    short_description: short,
    category: (api.category_list || "").split(",")[0] || (card.href || "").split("/")[3] || "",
    categories: (api.category_list || "").split(",").filter(Boolean),
    subcategories: (api.subcategory_list || "").split(",").filter(Boolean),
    discount_type: dt, discount_value: dv,
    member_only: api.member_exclusive_flag === "yes",
    redemption_method: clean(api.howto_redeem_desc),
    offer_page_url: page, redemption_url: page, outlink_url: strip(api.howto_redeem_url || ""),
    location_restricted: !!(api.state_blacklist?.length) || api.is_redeemable_only_in_person === true,
    in_person: api.is_redeemable_in_person === "true",
    in_person_only: api.is_redeemable_only_in_person === true,
    state_blacklist: api.state_blacklist || [],
    offer_timing: api.offer_timing || card.offertiming || "anytime",
    offer_type: api.dbr_offer_type || card.offertype || "",
    restrictions: clean(api.restrictions).slice(0, 600),
    keywords: (api.offer_keywords || []).map((k) => String(k).toLowerCase().trim()),
    merchant_phone: api.merchant_phone || "",
    source_url: AZ_URL, last_verified_at: now, active: !!page,
  };
}

export async function refreshCatalog({ log = console.log } = {}) {
  const now = new Date().toISOString();
  // 1. A-Z cards
  const html = await get(AZ_URL, "text");
  const cards = {};
  for (const m of html.matchAll(/<a\b[^>]*data-offerid="[^"]+"[^>]*>/g)) {
    const tag = m[0];
    const attr = (n) => (tag.match(new RegExp(`${n}=["']([^"']*)["']`)) || [])[1] || "";
    const dbr = attr("data-dbrofferid");
    if (dbr) cards[dbr] = { offerid: attr("data-offerid"), brand: attr("data-brand"),
      href: attr("href"), offertype: attr("data-offertype"), offertiming: attr("data-offertiming") };
  }
  // 2. category graph crawl
  const apiOffers = {}; const seen = new Set(); const queue = [...SEEDS];
  while (queue.length) {
    const slug = queue.shift();
    if (seen.has(slug)) continue;
    seen.add(slug);
    let data; try { data = await get(`${BASE}/etc/aarp/dbr/ws.api/offers/${slug}.json`); } catch { continue; }
    for (const cat of data?.results?.category || []) {
      for (const o of cat.offers || []) {
        if (o.dbr_offer_id && !apiOffers[o.dbr_offer_id]) apiOffers[o.dbr_offer_id] = o;
        for (const tag of o.tags || []) for (const t of [tag, ...(tag.sub_tags || [])]) {
          const s = (t.get_offers_url || "").split("/").pop()?.replace(".json", "");
          if (s && !seen.has(s) && !queue.includes(s)) queue.push(s);
        }
      }
    }
  }
  // 3. dataview fallback for A-Z offers missing from feeds
  for (const dbr of Object.keys(cards).filter((d) => !apiOffers[d])) {
    const href = cards[dbr].href?.replace(/^\/|\/$/g, "").replace(/\.modalview$/, "");
    if (!href) continue;
    try {
      const dv = await get(`${BASE}/content/aarpe/en/home/${href}/_jcr_content/.dataview.json`);
      if (dv?.dbr_offer_id) apiOffers[dbr] = dv;
    } catch { /* keep going */ }
  }
  // 4. normalize + diff + swap
  const ids = new Set([...Object.keys(cards), ...Object.keys(apiOffers)]);
  const fresh = {};
  for (const dbr of ids) {
    const b = normalize(dbr, apiOffers[dbr], cards[dbr], now);
    fresh[b.id] = b;
  }
  const path = catalogPath();
  const prev = existsSync(path) ? Object.fromEntries(
    JSON.parse(readFileSync(path, "utf8")).benefits.map((b) => [b.id, b])) : {};
  const WATCH = ["title", "short_description", "discount_value", "redemption_url", "outlink_url"];
  let added = 0, changed = 0;
  for (const [id, b] of Object.entries(fresh)) {
    b.first_seen = prev[id]?.first_seen || now;
    b.last_seen = now;
    const delta = !prev[id] || WATCH.some((f) => prev[id][f] !== b[f]);
    if (!prev[id]) added++; else if (delta) changed++;
    b.last_updated = delta ? now : prev[id]?.last_updated || now;
  }
  const removed = Object.keys(prev).filter((id) => !fresh[id]).length;
  // Safety valve: a broken scrape must never wipe the catalog (PRD §6 —
  // "never continue recommending an offer that can no longer be verified"
  // cuts both ways: don't un-verify 300 offers because one fetch failed).
  if (Object.keys(fresh).length < 100) {
    log(`refresh: only ${Object.keys(fresh).length} offers fetched — keeping existing catalog`);
    return { ok: false, total: Object.keys(fresh).length };
  }
  const catalog = {
    generated_at: now,
    sources: { az_page: AZ_URL, categories: [...seen] },
    counts: { total: Object.keys(fresh).length,
      with_outlink: Object.values(fresh).filter((b) => b.outlink_url).length,
      active: Object.values(fresh).filter((b) => b.active).length },
    benefits: Object.values(fresh).sort((a, b) => a.id.localeCompare(b.id)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(catalog));
  renameSync(path + ".tmp", path);
  try {
    appendFileSync(path.replace(/benefits\.json$/, "refresh_log.jsonl"),
      JSON.stringify({ run_at: now, total: catalog.counts.total, added, changed, removed }) + "\n");
  } catch { /* log file is best-effort */ }
  invalidateCatalog();
  log(`refresh: ${catalog.counts.total} benefits (+${added} ~${changed} -${removed})`);
  return { ok: true, ...catalog.counts, added, changed, removed };
}
