// Local restaurant offers — PRD §5 Source 2 (memberoffers.aarp.org) + §21 Nearby Savings.
//
// The offerwall is Augeo's Kigo network. Reverse-engineered flow (no browser needed):
//   1. GET https://memberoffers.aarp.org/restaurants/ — the page HTML embeds a fresh
//      anonymous encrypted token (`let token = "…"`), minted per render.
//   2. GET https://offersv2-api.p.augeocms.com/api/v2/kigo/offers?postalCode=<zip>&…
//      with that blob sent raw as the Authorization header.
// Local offers are queried live per ZIP (a national bulk ingest makes no sense for a
// proximity network); the token is cached ~30 min and re-scraped on 401.
const PAGE_URL = "https://memberoffers.aarp.org/restaurants/";
const API_BASE = "https://offersv2-api.p.augeocms.com/api/v2";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

let _token = null;
let _tokenAt = 0;

export async function getAugeoToken({ force = false, fetchImpl = fetch } = {}) {
  if (!force && _token && Date.now() - _tokenAt < 30 * 60 * 1000) return _token;
  const res = await fetchImpl(PAGE_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`memberoffers page ${res.status}`);
  const html = await res.text();
  const m = html.match(/let token = "([^"]+)"/);
  if (!m) throw new Error("no offerwall token in page — layout changed?");
  _token = m[1];
  _tokenAt = Date.now();
  return _token;
}

function normalizeLocal(result) {
  const o = result.offer || {};
  const v = result.vendor || {};
  const loc = (v.locations || [])[0] || {};
  return {
    id: `local-${v.vendorId}-${o.id}`,
    source: "augeo-kigo",
    brand: v.name,
    title: o.titleShort || o.name,
    summary: (o.descriptionShort || o.name || "").slice(0, 200),
    fine_print: o.finePrint || null,
    uses: o.details?.usesPerPeriod || null,
    savings_estimate: o.savings ?? o.rewardValue ?? null,
    in_store: !!o.isOfferInStore,
    online: !!o.isOfferOnline,
    redemption_methods: o.redemptionMethods || [],
    address: [loc.addressLine1, loc.city, loc.stateName, loc.postalCode].filter(Boolean).join(", "),
    lat: loc.latitude ?? null,
    lon: loc.longitude ?? null,
    distance_miles: loc.distance ?? result.distance ?? null,
    ends: o.endDate || null,
    // Outlink (PRD §5): local offers redeem in person/print via the offerwall page.
    redemption_url: `${PAGE_URL}?offerId=${o.offerId || o.id}&vendorId=${v.vendorId}`,
  };
}

/**
 * Live nearby search. zip required; keyword optional ("pizza", "steakhouse").
 * Returns normalized offers sorted by the network's relevance (distance).
 */
export async function searchLocalRestaurants({ zip, keyword = "", distance = 5, limit = 10, fetchImpl = fetch }) {
  if (!/^\d{5}$/.test(String(zip))) throw new Error("zip must be 5 digits");
  const attempt = async (token) => {
    const qs = new URLSearchParams({
      pageNumber: "1", numberOfRecordsPerPage: String(Math.min(limit, 50)),
      distance: String(distance), keyword, SortBy: "", SortDirection: "",
      GroupBy: "Vendors", LocationType: "All", postalCode: String(zip),
    });
    return fetchImpl(`${API_BASE}/kigo/offers?${qs}`, {
      headers: { Authorization: token, "Content-Type": "application/json",
        "User-Agent": UA, Origin: "https://memberoffers.aarp.org", Referer: PAGE_URL },
    });
  };
  let res = await attempt(await getAugeoToken({ fetchImpl }));
  if (res.status === 401 || res.status === 403) {
    res = await attempt(await getAugeoToken({ force: true, fetchImpl }));
  }
  if (!res.ok) throw new Error(`kigo/offers ${res.status}`);
  const data = await res.json();
  return {
    total: data.paging?.totalResults ?? 0,
    offers: (data.results || []).map(normalizeLocal).slice(0, limit),
  };
}
