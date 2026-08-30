// Proactive intelligence — PRD §§15-16, 31-33, 45.
//
// For a member: gather contextual triggers (watches, upcoming trips, temporal moments
// × memories), generate candidate recommendations, score each candidate
// (expected value × relevance × urgency vs. frequency/annoyance), and send only
// what clears the threshold. Most sweeps should send nothing — that is by design.
import { searchBenefits, benefitCard, loadCatalog } from "./benefits.js";
import { MemberStore } from "./memory.js";

const MIN_DAYS_BETWEEN_PROACTIVE = 7;   // §33: high relevance, LOW frequency
const SEND_THRESHOLD = 0.5;             // §31: every trigger must pass a relevance bar

// Temporal moments (§20) — month-scoped seasons and day-anchored holidays.
const MOMENTS = [
  { name: "Christmas shopping", months: [11, 12], matchKeys: ["family", "grandchildren_interests"],
    matchValues: /toy|lego|gift|grandkid|grandchild|disney/i, query: "gifts toys shopping",
    urgency: 0.8, lead: "Christmas shopping season is coming up" },
  { name: "Valentine's Day", months: [2], matchKeys: ["spouse_preference", "family", "important_date"],
    matchValues: /flower|wife|husband|spouse|anniversary/i, query: "flowers gifts",
    urgency: 0.7, lead: "Valentine's Day is coming up" },
  { name: "summer travel", months: [5, 6], matchKeys: ["destination_preference", "interest"],
    matchValues: /travel|beach|trip/i, query: "hotel travel vacation",
    urgency: 0.5, lead: "Summer travel season is almost here" },
];

function daysSince(iso, now) {
  if (!iso) return Infinity;
  return (new Date(now) - new Date(iso)) / 86400000;
}

/** Generate scored candidates for one member. Pure — does not send. */
export function generateCandidates(store, now) {
  let candidates = [];
  const ctx = store.rankingContext(now);
  const mems = store.activeMemories(now);
  const month = new Date(now).getUTCMonth() + 1;

  // 1. Watches (§15) — the member explicitly asked; relevance is inherently high.
  for (const w of store.state.watches.filter((w) => w.active)) {
    const hits = searchBenefits(w.subject, ctx, { limit: 2 });
    if (hits.length) {
      candidates.push({
        kind: "watch", subject: w.subject, benefit: benefitCard(hits[0].benefit),
        relevance: 0.9, urgency: 0.6, value: hits[0].score,
        message: `You asked me to keep an eye on ${w.subject}. ` +
          `There's an AARP benefit worth checking right now — ${hits[0].benefit.brand}: ${hits[0].benefit.title}. Want me to pull it up?`,
      });
    }
  }

  // 2. Upcoming trips (§13-14) — unmet needs × travel benefits.
  for (const t of store.state.trips.filter((t) => t.active)) {
    const needs = t.needs?.length ? t.needs.join(" ") : "hotel rental car restaurants";
    const hits = searchBenefits(`${needs} ${t.destination}`, ctx, { limit: 2 });
    if (hits.length) {
      candidates.push({
        kind: "trip", subject: t.destination, benefit: benefitCard(hits[0].benefit),
        relevance: 0.75, urgency: 0.6, value: hits[0].score,
        message: `Your ${t.destination} trip is coming up${t.approximate_dates ? ` (${t.approximate_dates})` : ""}. ` +
          `${hits[0].benefit.brand} — ${hits[0].benefit.title} could help. Want the link?`,
      });
    }
  }

  // 3. Temporal moments × memory (§17, §20).
  for (const m of MOMENTS) {
    if (!m.months.includes(month)) continue;
    const matched = mems.filter((mm) => m.matchKeys.includes(mm.key) &&
      m.matchValues.test(String(mm.value)) && mm.confidence >= 0.5);
    if (!matched.length) continue;
    const hits = searchBenefits(m.query, ctx, { limit: 2 });
    if (hits.length) {
      const remembered = matched[0].value;
      candidates.push({
        kind: "moment", subject: m.name, benefit: benefitCard(hits[0].benefit),
        relevance: 0.7 * Math.max(...matched.map((x) => x.confidence)),
        urgency: m.urgency, value: hits[0].score,
        message: `${m.lead}, and I remembered: ${remembered}. ` +
          `I found an AARP offer that might be useful — ${hits[0].benefit.brand}: ${hits[0].benefit.title}. Want to see it?`,
      });
    }
  }

  // §34: never send proactive messages in muted categories.
  const muted = new Set(store.state.muted_categories || []);
  candidates = candidates.filter((c) => !muted.has(c.benefit.category));

  // 4. Savings milestone (§31): celebrate crossing each $50 mark, once.
  const saved = store.totalSaved();
  const milestone = Math.floor(saved / 50) * 50;
  const celebrated = new Set((store.state.proactive_log || [])
    .filter((e) => e.kind === "milestone").map((e) => e.subject));
  if (milestone >= 50 && !celebrated.has(`milestone-${milestone}`)) {
    candidates.push({
      kind: "milestone", subject: `milestone-${milestone}`,
      benefit: { id: `milestone-${milestone}`, category: "milestone", redemption_url: "" },
      relevance: 0.8, urgency: 0.4, value: 0.6,
      message: `Nice one — you've now saved over $${milestone} with AARP this year 🎉 Ask me "what am I missing?" if you want to push that higher.`,
    });
  }

  // 5. New benefit in a frequently-used category (§31): catalog entries first seen in
  // the last 7 days that land in a category this member actually engages with.
  const freq = new Set(store.state.interactions.map((i) =>
    loadCatalog().benefits.find((b) => b.id === i.benefit_id)?.category).filter(Boolean));
  if (freq.size) {
    const weekAgo = new Date(new Date(now) - 7 * 86400000).toISOString();
    const fresh = loadCatalog().benefits.filter((b) =>
      b.first_seen > weekAgo && freq.has(b.category));
    if (fresh.length) {
      const b = fresh[0];
      candidates.push({
        kind: "new_benefit", subject: `new-${b.id}`, benefit: benefitCard(b, store.state.member_id),
        relevance: 0.6, urgency: 0.5, value: 0.6,
        message: `New AARP benefit in a category you use: ${b.brand} — ${b.title}. Want the link?`,
      });
    }
  }

  // 6. Reminders (§34: "remind me about this in December") — episodic memories the
  // agent stored with key "reminder" and an expiration = when to fire (fire in the
  // final 30 days before expiry, i.e. once the reminder window has arrived).
  for (const m of mems.filter((m) => m.key === "reminder" && m.expiration_date)) {
    const daysLeft = (new Date(m.expiration_date) - new Date(now)) / 86400000;
    if (daysLeft > 0 && daysLeft < 30) {
      candidates.push({
        kind: "reminder", subject: `reminder-${m.id}`,
        benefit: { id: `reminder-${m.id}`, category: "reminder", redemption_url: "" },
        relevance: 0.95, urgency: 0.7, value: 0.5,
        message: `You asked me to remind you: ${m.value}. Want me to look into it?`,
      });
    }
  }

  // Interruption score (§32): value × relevance × urgency.
  for (const c of candidates) c.score = c.value * c.relevance * c.urgency * 4; // scale to ~0..1
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * The sweep (§45): returns {sent, message?, candidate?, reason} and records the
 * proactive send so frequency caps hold. Deterministic message composition — the
 * anti-spam guarantee is easier to keep when no model can pad the copy.
 */
/** §38 weekly digest — opt-in, at most weekly, only when there is something to say. */
export function weeklyDigest(store, now) {
  if (!store.state.weekly_digest) return null;
  if (daysSince(store.state.last_digest_at, now) < 7) return null;
  const weekAgo = new Date(new Date(now) - 7 * 86400000).toISOString();
  const saved = store.state.savings_events.filter((e) => e.at >= weekAgo)
    .reduce((a, e) => a + (e.amount_saved || 0), 0);
  const candidates = generateCandidates(store, now);
  if (!saved && !candidates.length) return null;
  const lines = [`Your AARP savings this week: $${saved.toFixed(0)}.`];
  if (candidates[0]) lines.push(`I also found something that matches what you've told me you care about — ${candidates[0].benefit.brand ?? candidates[0].subject}. Want to see it?`);
  store.state.last_digest_at = now;
  store.save();
  return lines.join(" ");
}

export function evaluateProactive(memberId, { now = new Date().toISOString(), membersDir } = {}) {
  const store = new MemberStore(memberId, membersDir);
  const since = daysSince(store.state.last_proactive_at, now);
  if (since < MIN_DAYS_BETWEEN_PROACTIVE) {
    return { sent: false, reason: `frequency cap: last proactive message ${Math.floor(since)}d ago (< ${MIN_DAYS_BETWEEN_PROACTIVE}d)` };
  }
  let candidates = generateCandidates(store, now);
  // Repeat suppression (§31): never the same benefit for a subject again, and a
  // 30-day cooldown per subject — one nudge about Hawaii, not one per week.
  const log = store.state.proactive_log || [];
  const sentPairs = new Set(log.map((e) => `${e.subject}|${e.benefit_id}`));
  const recentSubjects = new Set(log.filter((e) => daysSince(e.at, now) < 30).map((e) => e.subject));
  candidates = candidates.filter((c) =>
    !sentPairs.has(`${c.subject}|${c.benefit.id}`) && !recentSubjects.has(c.subject));
  const best = candidates[0];
  if (!best || best.score < SEND_THRESHOLD) {
    return { sent: false, reason: best
      ? `best candidate "${best.subject}" scored ${best.score.toFixed(2)} < ${SEND_THRESHOLD}`
      : "no candidates", candidates };
  }
  store.state.last_proactive_at = now;
  store.state.proactive_log = [...(store.state.proactive_log || []),
    { subject: best.subject, benefit_id: best.benefit.id, kind: best.kind, at: now }];
  store.recordInteraction(best.benefit.id, "shown", now);
  store.logMessage("concierge", best.message, now);
  store.save();
  return { sent: true, message: best.message, candidate: best, candidates };
}
