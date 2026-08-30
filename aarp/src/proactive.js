// Proactive intelligence — PRD §§15-16, 31-33, 45.
//
// For a member: gather contextual triggers (watches, upcoming trips, temporal moments
// × memories), generate candidate recommendations, score each candidate
// (expected value × relevance × urgency vs. frequency/annoyance), and send only
// what clears the threshold. Most sweeps should send nothing — that is by design.
import { searchBenefits, benefitCard } from "./benefits.js";
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

  // Interruption score (§32): value × relevance × urgency.
  for (const c of candidates) c.score = c.value * c.relevance * c.urgency * 4; // scale to ~0..1
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * The sweep (§45): returns {sent, message?, candidate?, reason} and records the
 * proactive send so frequency caps hold. Deterministic message composition — the
 * anti-spam guarantee is easier to keep when no model can pad the copy.
 */
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
