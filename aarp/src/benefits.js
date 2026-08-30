// Benefits engine — load the ingested catalog, search it, rank per PRD §30.
// Zero-dependency ESM; the catalog is produced by aarp/ingestion/ingest_benefits.py.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, "..", "data", "benefits.json");

let _catalog = null;
export function loadCatalog(path = CATALOG_PATH) {
  if (!_catalog) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    _catalog = { ...raw, benefits: raw.benefits.filter((b) => b.active) };
  }
  return _catalog;
}

// Intent vocabulary: everyday words → catalog categories. Members never need
// AARP's terminology (PRD §7).
const INTENT_MAP = [
  [/\b(dinner|lunch|breakfast|eat|eating|restaurant|food|meal|takeout|pizza|steak|burger)\b/i, ["restaurants"]],
  [/\b(hotel|motel|stay|room|lodging|resort)\b/i, ["travel-hotels", "travel"]],
  [/\b(rental car|rent a car|car rental|renting a car)\b/i, ["travel-carrentals", "travel"]],
  [/\b(flight|fly|airline|airfare)\b/i, ["travel-flightsandvacationpackages", "travel"]],
  [/\b(cruise|cruising)\b/i, ["travel-cruises", "travel"]],
  [/\b(trip|travel|vacation|getaway|visiting)\b/i, ["travel"]],
  [/\b(movie|movies|show|concert|theme park|tickets?|entertainment|fun)\b/i, ["entertainment"]],
  [/\b(grocery|groceries|shopping|shop|gift|gifts|flowers|toys?|buy|buying)\b/i, ["shoppingandgroceries"]],
  [/\b(gas|fuel|oil change|tires?|car repair|roadside)\b/i, ["autoservice"]],
  [/\b(glasses|vision|eye|dental|dentist|hearing|prescription|pharmacy|health|wellness|gym|fitness)\b/i, ["healthandwellness"]],
  [/\b(insurance|insure|coverage)\b/i, ["insurance"]],
  [/\b(phone|internet|laptop|computer|tech|wireless|cell)\b/i, ["home-tech"]],
  [/\b(finance|financial|tax|taxes|invest|bank|money)\b/i, ["finances"]],
];

export function categoriesForIntent(text) {
  const cats = [];
  for (const [re, cs] of INTENT_MAP) if (re.test(text)) cats.push(...cs);
  return [...new Set(cats)];
}

const STOPWORDS = new Set(["need", "needs", "want", "going", "get", "getting", "good",
  "best", "near", "the", "and", "for", "with", "tonight", "today", "tomorrow", "this",
  "next", "week", "weekend", "month", "some", "any", "about", "have", "what", "discount",
  "discounts", "deal", "deals", "offer", "offers", "savings", "save", "aarp", "member",
  "members", "benefit", "benefits"]);

function tokenize(s, dropStops = false) {
  const toks = (s || "").toLowerCase().split(/[^a-z0-9%]+/).filter((t) => t.length > 2);
  return dropStops ? toks.filter((t) => !STOPWORDS.has(t)) : toks;
}

/**
 * Search + rank. PRD §30 BenefitScore:
 *   30% intent relevance, 20% preference, 15% economic value, 10% timing,
 *   10% location, 10% engagement likelihood, 5% novelty.
 * memberContext: { preferredBrands, preferredCategories, shownIds, ignoredIds, state }
 */
export function searchBenefits(query, memberContext = {}, opts = {}) {
  const { benefits } = loadCatalog(opts.catalogPath);
  const qTokens = tokenize(query, true);
  const intentCats = opts.categories?.length ? opts.categories : categoriesForIntent(query);
  const prefBrands = (memberContext.preferredBrands || []).map((b) => b.toLowerCase());
  const prefCats = memberContext.preferredCategories || [];
  const shown = new Set(memberContext.shownIds || []);
  const ignored = new Set(memberContext.ignoredIds || []);

  const scored = benefits.map((b) => {
    // intent relevance (0..1): category match + token overlap with keywords/brand/title
    let intent = 0;
    const allCats = [b.category, ...(b.subcategories || []), ...(b.categories || [])];
    if (intentCats.some((c) => allCats.includes(c))) intent += 0.55;
    // the FIRST intent category is the most specific (e.g. travel-carrentals before
    // travel) — an exact hit on it is a much stronger signal than broad membership
    if (intentCats.length && allCats.includes(intentCats[0])) intent += 0.25;
    const hay = new Set([...tokenize(b.brand), ...tokenize(b.title), ...b.keywords.flatMap(tokenize)]);
    const hits = qTokens.filter((t) => hay.has(t)).length;
    intent += Math.min(0.45, hits * 0.18);
    // brand named directly in query is a near-lock
    if (qTokens.length && tokenize(b.brand).some((t) => qTokens.includes(t))) intent = Math.max(intent, 0.95);

    // preference relevance (0..1)
    let pref = 0;
    if (prefBrands.some((p) => b.brand.toLowerCase().includes(p))) pref += 0.7;
    if (prefCats.some((c) => allCats.includes(c))) pref += 0.3;

    // economic value (0..1): normalized discount size
    const value = b.discount_type === "percentage" ? Math.min(1, (b.discount_value || 0) / 30)
      : b.discount_type === "dollar" ? Math.min(1, (b.discount_value || 0) / 100) : 0.3;

    // timing (0..1): limited-time offers get urgency
    const timing = b.offer_type === "lto" || b.offer_timing !== "anytime" ? 0.8 : 0.5;

    // location (0..1): penalize state-blacklisted (member state unknown → neutral)
    const location = memberContext.state && b.state_blacklist?.includes(memberContext.state) ? 0 : 0.5;

    // engagement likelihood (0..1): ignored things sink
    const engage = ignored.has(b.id) ? 0 : 0.5;

    // novelty (0..1): not shown before
    const novelty = shown.has(b.id) ? 0.2 : 1;

    const score = 0.3 * intent + 0.2 * pref + 0.15 * value + 0.1 * timing +
      0.1 * location + 0.1 * engage + 0.05 * novelty;
    return { benefit: b, score, intent };
  });

  const gate = intentCats.length ? 0.3 : 0.15;
  const ranked = scored
    .filter((s) => s.intent > gate && s.score > 0.2)
    .sort((a, b) => b.score - a.score);
  // One result per brand — the catalog carries quarterly LTO variants of evergreen offers.
  const seen = new Set();
  const deduped = ranked.filter((r) => {
    const key = r.benefit.brand.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.slice(0, opts.limit ?? 5);
}

/** Compact card for a benefit — what the agent gets as tool output. */
export function benefitCard(b) {
  return {
    id: b.id,
    brand: b.brand,
    title: b.title,
    summary: b.short_description || b.title,
    category: b.category,
    discount: b.discount_value ? `${b.discount_value}${b.discount_type === "percentage" ? "%" : " USD"}` : null,
    redemption: b.redemption_method || null,
    redemption_url: b.redemption_url,   // PRD §5: always send a tappable link
    outlink_url: b.outlink_url || null,
    in_person_only: b.in_person_only || false,
    restrictions_note: b.state_blacklist?.length ? `Not available in: ${b.state_blacklist.join(", ")}` : null,
    last_verified_at: b.last_verified_at,
  };
}
