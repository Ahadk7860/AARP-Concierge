// Member memory store — PRD §§8-12, 43. One JSON file per member (P0 demo store;
// swaps to Postgres behind the same interface at pilot).
//
// Memory kinds: profile | behavioral | episodic | benefit | reward (PRD §10).
// Every memory carries value, confidence, source, created_at, last_reinforced_at,
// expiration_date, user_confirmed, active (PRD §43).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMBERS_DIR = process.env.AARP_MEMBERS_DIR || join(HERE, "..", "data", "members");

const EMPTY = () => ({
  member_id: null,
  created_at: null,
  home_location: null,
  memories: [],        // {id, kind, key, value, confidence, source, created_at, last_reinforced_at, expiration_date, user_confirmed, active}
  trips: [],           // {id, destination, approximate_dates, travelers, needs, frequency, watch_enabled, created_at, active}
  watches: [],         // {id, watch_type, subject, trigger, active, created_at}
  saved_benefits: [],  // benefit ids
  interactions: [],    // {benefit_id, action: shown|clicked|saved|redeemed|dismissed, at}
  savings_events: [],  // {benefit_id, amount_saved, bill_amount, at}
  message_log: [],     // {role, text, at} — conversation history (last N)
  muted_categories: [],// §34: "don't send restaurant offers"
  savings_goal: null,  // §38: {target, set_at}
  weekly_digest: false,// §38: opt-in weekly savings digest
  last_digest_at: null,
});

export class MemberStore {
  constructor(memberId, dir = MEMBERS_DIR) {
    this.path = join(dir, `${memberId.replace(/[^a-zA-Z0-9_+-]/g, "_")}.json`);
    mkdirSync(dir, { recursive: true });
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : { ...EMPTY(), member_id: memberId, created_at: new Date().toISOString() };
  }

  save() { writeFileSync(this.path, JSON.stringify(this.state, null, 1)); }

  /** Store or reinforce a memory. Same kind+key+value → reinforce confidence. */
  remember({ kind, key, value, confidence, source = "inferred", expiresAt = null, now }) {
    confidence = confidence ?? (source === "explicit" ? 0.9 : 0.6);
    const at = now || new Date().toISOString();
    const existing = this.state.memories.find(
      (m) => m.active && m.kind === kind && m.key === key &&
             String(m.value).toLowerCase() === String(value).toLowerCase());
    if (existing) {
      existing.confidence = Math.min(1, Math.max(existing.confidence, confidence) + 0.1);
      existing.last_reinforced_at = at;
      if (source === "explicit") { existing.source = "explicit"; existing.user_confirmed = true; }
    } else {
      this.state.memories.push({
        id: randomUUID().slice(0, 8), kind, key, value,
        confidence, source, created_at: at, last_reinforced_at: at,
        expiration_date: expiresAt, user_confirmed: source === "explicit", active: true,
      });
    }
    this.save();
  }

  /** Forget by fuzzy match on key/value — PRD §34 member control. */
  forget(text) {
    const t = text.toLowerCase();
    const hits = this.state.memories.filter(
      (m) => m.active && (String(m.value).toLowerCase().includes(t) || m.key.toLowerCase().includes(t)));
    for (const m of hits) m.active = false;
    this.save();
    return hits.length;
  }

  /** Weaken confidence on a memory (negative signal, PRD §12). */
  weaken(id, delta = 0.2) {
    const m = this.state.memories.find((x) => x.id === id);
    if (m) { m.confidence = Math.max(0, m.confidence - delta); if (m.confidence < 0.2) m.active = false; this.save(); }
  }

  /** Active, unexpired memories as of a (possibly simulated) date. */
  activeMemories(now = new Date().toISOString()) {
    return this.state.memories.filter(
      (m) => m.active && (!m.expiration_date || m.expiration_date > now));
  }

  /** Profile summary the agent sees each turn. */
  profileSummary(now = new Date().toISOString()) {
    const mems = this.activeMemories(now);
    const lines = mems.map((m) =>
      `- [${m.kind}] ${m.key}: ${m.value} (confidence ${m.confidence.toFixed(2)}, ${m.source}${m.user_confirmed ? ", confirmed" : ""})`);
    const trips = this.state.trips.filter((t) => t.active).map(
      (t) => `- trip: ${t.destination} (${t.approximate_dates || "dates unknown"}) needs: ${(t.needs || []).join(", ") || "?"}`);
    const watches = this.state.watches.filter((w) => w.active).map(
      (w) => `- watch: ${w.watch_type} — ${w.subject}`);
    return {
      linked: !!this.state.linked,
      home_location: this.state.home_location,
      memory_lines: lines,
      trip_lines: trips,
      watch_lines: watches,
      saved_benefits: this.state.saved_benefits,
      total_saved: this.totalSaved(),
    };
  }

  /** Context object the ranker uses (PRD §30). */
  rankingContext(now = new Date().toISOString()) {
    const mems = this.activeMemories(now);
    const val = (key) => mems.filter((m) => m.key === key && m.confidence >= 0.5).map((m) => m.value);
    return {
      preferredBrands: val("brand_preference"),
      preferredCategories: val("category_preference"),
      shownIds: this.state.interactions.filter((i) => i.action === "shown").map((i) => i.benefit_id),
      ignoredIds: this.state.interactions.filter((i) => i.action === "dismissed").map((i) => i.benefit_id),
      state: this.state.home_location?.match(/\b([A-Z]{2})\b/)?.[1] || null,
      mutedCategories: this.state.muted_categories || [],
    };
  }

  recordInteraction(benefitId, action, now) {
    this.state.interactions.push({ benefit_id: benefitId, action, at: now || new Date().toISOString() });
    this.save();
  }

  recordSavings(benefitId, amountSaved, billAmount, now) {
    this.state.savings_events.push({
      benefit_id: benefitId, amount_saved: amountSaved, bill_amount: billAmount ?? null,
      at: now || new Date().toISOString(),
    });
    this.recordInteraction(benefitId, "redeemed", now);
  }

  totalSaved() {
    return this.state.savings_events.reduce((s, e) => s + (e.amount_saved || 0), 0);
  }

  savingsByCategory(catalogById) {
    const by = {};
    for (const e of this.state.savings_events) {
      const cat = catalogById?.[e.benefit_id]?.category || "other";
      by[cat] = (by[cat] || 0) + (e.amount_saved || 0);
    }
    return by;
  }

  addTrip({ destination, approximate_dates, travelers = [], needs = [], frequency = null, now }) {
    const t = { id: randomUUID().slice(0, 8), destination, approximate_dates, travelers, needs,
      frequency, watch_enabled: false, created_at: now || new Date().toISOString(), active: true };
    this.state.trips.push(t); this.save(); return t;
  }

  addWatch({ watch_type, subject, trigger = "meaningfully_good_opportunity", now }) {
    const w = { id: randomUUID().slice(0, 8), watch_type, subject, trigger, active: true,
      created_at: now || new Date().toISOString() };
    this.state.watches.push(w); this.save(); return w;
  }

  muteCategory(cat) {
    if (!this.state.muted_categories.includes(cat)) this.state.muted_categories.push(cat);
    this.save();
  }

  unmuteCategory(cat) {
    this.state.muted_categories = this.state.muted_categories.filter((c) => c !== cat);
    this.save();
  }

  removeWatch(text) {
    const t = text.toLowerCase();
    const hits = this.state.watches.filter((w) => w.active && w.subject.toLowerCase().includes(t));
    for (const w of hits) w.active = false;
    this.save(); return hits.length;
  }

  saveBenefit(id) {
    if (!this.state.saved_benefits.includes(id)) this.state.saved_benefits.push(id);
    this.recordInteraction(id, "saved");
  }

  /** Wipe everything learned about this member, keeping the record itself (§34). */
  reset(now) {
    const { member_id, created_at, space_id } = this.state;
    this.state = { ...EMPTY(), member_id, created_at, space_id, reset_at: now || new Date().toISOString() };
    this.save();
  }

  logMessage(role, text, now) {
    this.state.message_log.push({ role, text, at: now || new Date().toISOString() });
    this.state.message_log = this.state.message_log.slice(-40);
    this.save();
  }
}
