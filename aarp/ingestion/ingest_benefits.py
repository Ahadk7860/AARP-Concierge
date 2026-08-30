"""AARP benefits ingestion — PRD §5 (Source 1: all-offers A-Z) + §6 (refresh/diff).

Two feeds, joined by dbr_offer_id:
  1. The A-Z page's offer cards — the authoritative list of what exists today.
  2. The structured offers API: /etc/aarp/dbr/ws.api/offers/<category>.json —
     rich per-offer records (descriptions, outlinks, restrictions, keywords).

Category slugs are discovered by crawling the tag graph, seeded with known slugs;
offers on the A-Z page missing from every category feed fall back to their
per-offer AEM dataview.json.

Output: aarp/data/benefits.json (normalized catalog, PRD §5 schema) and
aarp/data/refresh_log.jsonl (one diff entry per run, PRD §6).

Stdlib only. Run: python3 aarp/ingestion/ingest_benefits.py
"""
from __future__ import annotations

import html as htmllib
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.aarp.org"
AZ_URL = f"{BASE}/membership/benefits/all-offers-a-z/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

SEED_SLUGS = [
    "restaurants", "travel", "entertainment", "insurance", "healthandwellness",
    "shopping", "shoppingandgroceries", "groceries", "auto", "gasandauto",
    "technology", "homeandtechnology", "homeandrealestate", "finances",
    "workandfinances", "advocacy", "community", "caregiving", "familycaregiving",
    "magazines", "magazinesandresources", "limitedtimememberoffers",
]

# Third-party tracking params to strip from outlinks (PRD §5 outlink rules —
# AARP's own attribution params like intcmp/cmp are preserved).
STRIP_PARAMS = re.compile(r"(gclid|gbraid|wbraid|fbclid|msclkid|adobe_mc\w*|gclsrc|gad_\w+)=[^&]*&?")


def fetch(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_json(url: str):
    try:
        return json.loads(fetch(url))
    except Exception:
        return None


def clean_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def clean_url(u: str) -> str:
    u = STRIP_PARAMS.sub("", u or "").rstrip("?&")
    if u.startswith("/"):
        u = BASE + u
    return u


def parse_az_cards(html: str) -> dict[str, dict]:
    """Offer cards on the A-Z page → {dbr_offer_id: card}."""
    cards: dict[str, dict] = {}
    for m in re.finditer(r"<a\b[^>]*data-offerid=\"[^\"]+\"[^>]*>", html):
        tag = m.group(0)

        def attr(name: str) -> str:
            a = re.search(rf'{name}=["\']([^"\']*)["\']', tag)
            return htmllib.unescape(a.group(1)) if a else ""

        dbr = attr("data-dbrofferid")
        if not dbr:
            continue
        cards[dbr] = {
            "analytics_offerid": attr("data-offerid"),
            "brand": attr("data-brand"),
            "categories_display": [c.strip() for c in attr("data-categoryid").split(",") if c.strip()],
            "offer_type": attr("data-offertype"),
            "offer_timing": attr("data-offertiming"),
            "href": attr("href"),
            "modal_url": attr("data-modal-url"),
        }
    return cards


def crawl_categories(seeds: list[str]) -> tuple[dict[str, dict], dict[str, str]]:
    """BFS the category tag graph. Returns ({dbr_offer_id: api_record}, {slug: title})."""
    offers: dict[str, dict] = {}
    seen_slugs: dict[str, str] = {}
    queue = list(dict.fromkeys(seeds))
    while queue:
        slug = queue.pop(0)
        if slug in seen_slugs:
            continue
        seen_slugs[slug] = ""
        data = fetch_json(f"{BASE}/etc/aarp/dbr/ws.api/offers/{slug}.json")
        if not data:
            continue
        for cat in data.get("results", {}).get("category", []):
            seen_slugs[slug] = cat.get("title", slug)
            for offer in cat.get("offers", []):
                oid = offer.get("dbr_offer_id")
                if oid and oid not in offers:
                    offers[oid] = offer
                for tag in offer.get("tags", []):
                    for t in [tag] + tag.get("sub_tags", []):
                        s = (t.get("get_offers_url") or "").rsplit("/", 1)[-1].removesuffix(".json")
                        if s and s not in seen_slugs and s not in queue:
                            queue.append(s)
    return offers, {k: v for k, v in seen_slugs.items() if v}


def fetch_dataview(href: str):
    """Per-offer AEM fallback for A-Z offers missing from every category feed."""
    path = href.strip("/").removesuffix(".modalview")
    return fetch_json(f"{BASE}/content/aarpe/en/home/{path}/_jcr_content/.dataview.json")


DISCOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
DOLLAR_RE = re.compile(r"\$\s*(\d+(?:\.\d+)?)")


def infer_discount(*texts: str) -> tuple[str, float | None]:
    for t in texts:
        m = DISCOUNT_RE.search(t or "")
        if m:
            return "percentage", float(m.group(1))
    for t in texts:
        m = DOLLAR_RE.search(t or "")
        if m:
            return "dollar", float(m.group(1))
    return "other", None


def normalize(dbr_id: str, api: dict | None, card: dict | None, now: str) -> dict:
    api = api or {}
    card = card or {}
    slug = (card.get("analytics_offerid") or api.get("analytics_offerid") or dbr_id)
    slug = re.sub(r"-\d+$", "", slug)  # outback-steakhouse-10087 → outback-steakhouse
    title = clean_html(api.get("offer_title", ""))
    short = clean_html(api.get("offer_short_description", ""))
    desc = clean_html(api.get("offer_description", ""))
    dtype, dvalue = infer_discount(title, short, desc)
    offer_page = clean_url(api.get("offer_deeplink_url") or card.get("href") or "")
    outlink = clean_url(api.get("howto_redeem_url") or "")
    return {
        "id": slug,
        "dbr_offer_id": dbr_id,
        "brand": clean_html(api.get("source_name") or (card.get("brand") or "").split("|")[-1]),
        "title": title or short,
        "description": desc,
        "short_description": short,
        "category": (api.get("category_list") or "").split(",")[0] or _cat_from_href(card.get("href", "")),
        "categories": [c for c in (api.get("category_list") or "").split(",") if c]
                       or card.get("categories_display", []),
        "subcategories": [c for c in (api.get("subcategory_list") or "").split(",") if c],
        "discount_type": dtype,
        "discount_value": dvalue,
        "member_only": api.get("member_exclusive_flag") == "yes",
        "redemption_method": clean_html(api.get("howto_redeem_desc", "")),
        # Outlinks — required on every benefit (PRD §5)
        "offer_page_url": offer_page,
        "redemption_url": offer_page,  # AARP-hosted deep link; primary link sent in iMessage
        "outlink_url": outlink,        # final partner destination, when AARP exposes one
        "location_restricted": bool(api.get("state_blacklist")) or api.get("is_redeemable_only_in_person") is True,
        "in_person": api.get("is_redeemable_in_person") == "true",
        "in_person_only": api.get("is_redeemable_only_in_person") is True,
        "state_blacklist": api.get("state_blacklist") or [],
        "offer_timing": api.get("offer_timing") or card.get("offer_timing") or "anytime",
        "offer_type": api.get("dbr_offer_type") or card.get("offer_type") or "",
        "restrictions": clean_html(api.get("restrictions", ""))[:600],
        "keywords": [k.lower() for k in (api.get("offer_keywords") or [])],
        "merchant_phone": api.get("merchant_phone") or "",
        "source_url": AZ_URL,
        "last_verified_at": now,
    }


def _cat_from_href(href: str) -> str:
    m = re.match(r"/membership/benefits/([a-z0-9-]+)/", href or "")
    return m.group(1) if m else ""


def diff_catalog(prev: dict[str, dict], curr: dict[str, dict]) -> dict:
    added = sorted(set(curr) - set(prev))
    removed = sorted(set(prev) - set(curr))
    changed = []
    WATCH = ["title", "short_description", "discount_value", "redemption_url", "outlink_url", "restrictions"]
    for oid in set(curr) & set(prev):
        deltas = {f: {"prev": prev[oid].get(f), "curr": curr[oid].get(f)}
                  for f in WATCH if prev[oid].get(f) != curr[oid].get(f)}
        if deltas:
            changed.append({"id": oid, "deltas": deltas})
    return {"added": added, "removed": removed, "changed": changed}


def main() -> int:
    now = datetime.now(timezone.utc).isoformat()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / "benefits.json"
    log_path = DATA_DIR / "refresh_log.jsonl"

    print("fetching A-Z page …", file=sys.stderr)
    az_html = fetch(AZ_URL).decode("utf-8", "replace")
    cards = parse_az_cards(az_html)
    print(f"  {len(cards)} offer cards", file=sys.stderr)

    print("crawling category API …", file=sys.stderr)
    api_offers, slugs = crawl_categories(SEED_SLUGS)
    print(f"  {len(api_offers)} offers across {len(slugs)} categories: {sorted(slugs)}", file=sys.stderr)

    missing = [d for d in cards if d not in api_offers]
    print(f"  {len(missing)} A-Z offers not in category feeds; trying dataview fallback", file=sys.stderr)
    for dbr in missing:
        dv = fetch_dataview(cards[dbr]["href"]) if cards[dbr].get("href") else None
        if dv and dv.get("dbr_offer_id"):
            api_offers[dbr] = dv

    all_ids = set(cards) | set(api_offers)
    benefits = {}
    for dbr in all_ids:
        b = normalize(dbr, api_offers.get(dbr), cards.get(dbr), now)
        # PRD §5: a benefit without a tappable link is not shippable
        b["active"] = bool(b["redemption_url"] or b["offer_page_url"])
        benefits[b["id"]] = b

    # refresh bookkeeping (PRD §6)
    prev = {}
    if out_path.exists():
        prev = {b["id"]: b for b in json.loads(out_path.read_text())["benefits"]}
    for bid, b in benefits.items():
        b["first_seen"] = prev.get(bid, {}).get("first_seen", now)
        b["last_seen"] = now
        changed = any(prev.get(bid, {}).get(f) != b.get(f)
                      for f in ["title", "short_description", "discount_value", "redemption_url", "outlink_url"])
        b["last_updated"] = now if (bid not in prev or changed) else prev[bid].get("last_updated", now)

    d = diff_catalog(prev, benefits)
    with log_path.open("a") as f:
        f.write(json.dumps({"run_at": now, "total": len(benefits),
                            "added": len(d["added"]), "removed": len(d["removed"]),
                            "changed": len(d["changed"]), "diff": d}) + "\n")

    catalog = {
        "generated_at": now,
        "sources": {"az_page": AZ_URL, "categories": slugs},
        "counts": {"total": len(benefits),
                   "with_outlink": sum(1 for b in benefits.values() if b["outlink_url"]),
                   "active": sum(1 for b in benefits.values() if b["active"])},
        "benefits": sorted(benefits.values(), key=lambda b: b["id"]),
    }
    out_path.write_text(json.dumps(catalog, indent=1, ensure_ascii=False))
    print(f"wrote {out_path} — {catalog['counts']}", file=sys.stderr)
    print(f"diff: +{len(d['added'])} -{len(d['removed'])} ~{len(d['changed'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
