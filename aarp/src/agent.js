// AARP Concierge agent — tool loop + persona (PRD §§40, 42, 44).
// Providers: "anthropic" (live, needs ANTHROPIC_API_KEY) | "fake" (deterministic, for tests).
import { searchBenefits, benefitCard, loadCatalog } from "./benefits.js";
import { MemberStore } from "./memory.js";

const MODEL = process.env.AARP_MODEL || "claude-sonnet-5";

export const PERSONA = `You are the AARP Concierge — AARP in the member's contacts, over iMessage.

Personality: warm, concise, knowledgeable, observant, trustworthy, proactive without being
pushy, appropriate for older adults without sounding patronizing. Keep replies short —
this is a text message, not an email. 1-4 short sentences or a tight list. Emoji sparingly.

Core loop: the member tells you what they're doing or about to buy. You find the most
relevant AARP benefit, explain it simply, and give them the link to redeem it.

Hard rules:
- NEVER invent a benefit, discount, or number. Only cite benefits returned by the
  search_benefits tool this conversation. If nothing applies say so plainly:
  "I couldn't find an AARP benefit that clearly applies right now."
- Always include the redemption link when recommending a benefit (the tool gives you
  redemption_url). Mention important restrictions (in-person only, participating
  locations, state exclusions) in one short clause.
- Show at most 3 options. Lead with the best match and say why it fits them.
- Never ask for passwords or payment details over iMessage.

Memory: you remember what members tell you (the remember tool). Extract durable facts
from every message — home city, family (grandchildren, spouse), destinations they visit,
brands and cuisines they like, upcoming trips, important dates. Use kind=profile for
long-lived facts, kind=episodic (with expires) for current events like trips.
Explicit statements → source=explicit, confidence 0.9. Inferences → source=inferred,
confidence 0.5-0.7, and don't assert them back as facts ("It looks like you might…").
Reference memory naturally and sparingly: "Since you mentioned…", "I remembered…".
If asked "what do you remember about me", list it plainly and note they can ask you to
change or forget anything.

If the member says they used a benefit and what they spent, record it with
record_benefit_used and tell them their running total. If they ask to watch for
something ("keep an eye out for…"), create a watch and say you'll only reach out when
something looks genuinely worthwhile.

Today's date is {{TODAY}}. The member's profile so far:
{{PROFILE}}`;

export const TOOLS = [
  { name: "search_benefits",
    description: "Search verified AARP benefits. Query with the member's own words (e.g. 'steakhouse dinner', 'rental car Miami'). Returns ranked benefit cards with redemption links. Only recommend benefits returned here.",
    input_schema: { type: "object", properties: {
      query: { type: "string" },
      category: { type: "string", description: "Optional category slug filter, e.g. restaurants, travel-hotels, travel-carrentals, entertainment, shoppingandgroceries" },
    }, required: ["query"] } },
  { name: "remember",
    description: "Store a fact about the member. kind: profile (durable), episodic (expires — set expires_at), behavioral. key examples: home_location, family, grandchildren_interests, destination_preference, brand_preference, category_preference, cuisine_preference, spouse_preference, important_date.",
    input_schema: { type: "object", properties: {
      kind: { type: "string", enum: ["profile", "episodic", "behavioral"] },
      key: { type: "string" }, value: { type: "string" },
      source: { type: "string", enum: ["explicit", "inferred"] },
      confidence: { type: "number" },
      expires_at: { type: "string", description: "ISO date, episodic only" },
    }, required: ["kind", "key", "value", "source"] } },
  { name: "forget",
    description: "Deactivate memories matching the text (member asked to forget something).",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add_trip",
    description: "Record an upcoming or recurring trip.",
    input_schema: { type: "object", properties: {
      destination: { type: "string" }, approximate_dates: { type: "string" },
      needs: { type: "array", items: { type: "string" } },
      frequency: { type: "string" },
    }, required: ["destination"] } },
  { name: "create_watch",
    description: "Member asked AARP to watch for opportunities (deals for a destination, category, or interest).",
    input_schema: { type: "object", properties: {
      watch_type: { type: "string" }, subject: { type: "string" } }, required: ["watch_type", "subject"] } },
  { name: "remove_watch",
    input_schema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
    description: "Stop watching a subject." },
  { name: "save_benefit",
    description: "Member said 'save that' — save a benefit id for later.",
    input_schema: { type: "object", properties: { benefit_id: { type: "string" } }, required: ["benefit_id"] } },
  { name: "record_benefit_used",
    description: "Member confirmed using a benefit. Compute amount_saved from the bill and the discount if possible.",
    input_schema: { type: "object", properties: {
      benefit_id: { type: "string" }, amount_saved: { type: "number" }, bill_amount: { type: "number" },
    }, required: ["benefit_id", "amount_saved"] } },
  { name: "get_savings",
    description: "The member's savings summary (total + by category).",
    input_schema: { type: "object", properties: {} } },
];

/** Execute one tool call against the member's store. */
export function invokeTool(name, input, store, now) {
  switch (name) {
    case "search_benefits": {
      const results = searchBenefits(input.query, store.rankingContext(now),
        input.category ? { categories: [input.category] } : {});
      const cards = results.map((r) => benefitCard(r.benefit));
      for (const c of cards) store.recordInteraction(c.id, "shown", now);
      return cards.length ? { results: cards } : { results: [], note: "No verified AARP benefit matches. Say so plainly — do not invent one." };
    }
    case "remember":
      store.remember({ kind: input.kind, key: input.key, value: input.value,
        confidence: input.confidence ?? (input.source === "explicit" ? 0.9 : 0.6),
        source: input.source, expiresAt: input.expires_at || null, now });
      return { ok: true };
    case "forget": return { forgotten: store.forget(input.text) };
    case "add_trip": return { trip: store.addTrip({ ...input, now }) };
    case "create_watch": return { watch: store.addWatch({ ...input, now }) };
    case "remove_watch": return { removed: store.removeWatch(input.subject) };
    case "save_benefit": { store.saveBenefit(input.benefit_id); return { ok: true, saved: store.state.saved_benefits }; }
    case "record_benefit_used": {
      store.recordSavings(input.benefit_id, input.amount_saved, input.bill_amount ?? null, now);
      return { ok: true, total_saved: store.totalSaved() };
    }
    case "get_savings": {
      const byId = Object.fromEntries(loadCatalog().benefits.map((b) => [b.id, b]));
      return { total_saved: store.totalSaved(), by_category: store.savingsByCategory(byId),
        benefits_used: store.state.savings_events.length };
    }
    default: return { error: `unknown tool ${name}` };
  }
}

function systemPrompt(store, now) {
  const p = store.profileSummary(now);
  const profile = [
    p.home_location ? `Home: ${p.home_location}` : null,
    ...p.memory_lines, ...p.trip_lines, ...p.watch_lines,
    p.saved_benefits.length ? `Saved benefits: ${p.saved_benefits.join(", ")}` : null,
    p.total_saved ? `Total saved this year: $${p.total_saved.toFixed(0)}` : null,
  ].filter(Boolean).join("\n") || "(new member — nothing learned yet)";
  return PERSONA.replace("{{TODAY}}", now.slice(0, 10)).replace("{{PROFILE}}", profile);
}

/** Anthropic Messages API tool loop. */
async function anthropicTurn(store, userText, now, history) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — use AARP_PROVIDER=fake or supply a key");
  const messages = [...history, { role: "user", content: userText }];
  for (let round = 0; round < 6; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: systemPrompt(store, now),
        tools: TOOLS, messages }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = await res.json();
    const toolUses = msg.content.filter((c) => c.type === "tool_use");
    if (!toolUses.length || msg.stop_reason !== "tool_use") {
      return msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    }
    messages.push({ role: "assistant", content: msg.content });
    messages.push({ role: "user", content: toolUses.map((tu) => ({
      type: "tool_result", tool_use_id: tu.id,
      content: JSON.stringify(invokeTool(tu.name, tu.input, store, now)),
    })) });
  }
  return "Sorry — I hit a snag looking that up. Try me again?";
}

/** Deterministic provider for tests/offline demo: intent → search → templated reply. */
function fakeTurn(store, userText, now) {
  const t = userText.toLowerCase();
  if (/what do you remember/.test(t)) {
    const lines = store.profileSummary(now).memory_lines;
    return lines.length
      ? `A few things you've told me that help me find better benefits:\n${lines.map((l) => "•" + l.replace(/^- \[\w+\] /, " ")).join("\n")}\nYou can ask me to change or forget any of these anytime.`
      : "I don't have anything saved about you yet — as we talk, I'll remember what matters (and you can ask me to forget anything).";
  }
  if (/how much have i saved|my savings/.test(t)) {
    const s = invokeTool("get_savings", {}, store, now);
    return `You've saved about $${s.total_saved.toFixed(0)} with AARP this year 🎉`;
  }
  const results = searchBenefits(userText, store.rankingContext(now));
  if (!results.length) return "I couldn't find an AARP benefit that clearly applies right now.";
  const cards = results.slice(0, 3).map((r) => benefitCard(r.benefit));
  for (const c of cards) store.recordInteraction(c.id, "shown", now);
  const lines = cards.map((c) => `${c.brand} — ${c.title}\n${c.redemption_url}`);
  return `I found ${cards.length} good option${cards.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

/**
 * One conversational turn. now: ISO timestamp (simulated dates for the demo, PRD §49).
 * Returns the reply text; persists memory + message log.
 */
export async function converse(memberId, userText, { now = new Date().toISOString(), provider = process.env.AARP_PROVIDER || "anthropic", membersDir } = {}) {
  const store = new MemberStore(memberId, membersDir);
  store.logMessage("member", userText, now);
  const history = store.state.message_log.slice(0, -1).slice(-12)
    .map((m) => ({ role: m.role === "member" ? "user" : "assistant", content: m.text }));
  const reply = provider === "fake"
    ? fakeTurn(store, userText, now)
    : await anthropicTurn(store, userText, now, history);
  store.logMessage("concierge", reply, now);
  return reply;
}
