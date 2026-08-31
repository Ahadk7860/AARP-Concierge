// AARP Concierge agent — tool loop + persona (PRD §§40, 42, 44).
// Providers: "anthropic" (live, needs ANTHROPIC_API_KEY) | "fake" (deterministic, for tests).
import { searchBenefits, benefitCard, loadCatalog, memberHash } from "./benefits.js";
import { getConfig, renderConfigPrompt } from "./agent-config.js";
import { MemberStore } from "./memory.js";
import { searchLocalRestaurants } from "./local_restaurants.js";
import { getRewards } from "./rewards.js";

const MODEL = process.env.AARP_MODEL || "claude-sonnet-5";

export const PERSONA = `You are the AARP Concierge — AARP in the member's contacts, over iMessage.

Personality: warm, concise, knowledgeable, observant, trustworthy, proactive without being
pushy, appropriate for older adults without sounding patronizing. Keep replies short —
this is a text message, not an email. 1-4 short sentences or a tight list. Emoji sparingly.

FORMATTING — this is iMessage, which has NO markdown. Never use asterisks for bold or
italics, never use backticks, headings, or bracket-and-parenthesis links: they show up
as literal punctuation on the member's phone. Put a URL on its own, bare, and let the phone linkify it. A short
list is fine as plain lines, e.g.:
  Avis — up to 35% off base rates
  https://example.com/link
Never send more than 3 options, and never more than 3 links in one message.
Never promise or reference a link, offer, or url you did not include verbatim in the
message. If you don't have the url yet, call the tool that returns it before you send.

Core loop: the member tells you what they're doing or about to buy. You find the most
relevant AARP benefit, explain it simply, and give them the link to redeem it.

SMART FOLLOW-UPS — Answer first. Learn second. After delivering the useful answer, you
may add AT MOST ONE short question chosen to improve future recommendations — and only
when the answer would actually change what you recommend next time. Good ones:
  dinner search → "Italian, steak, casual, or something else?"
  vague dinner ask → "what matters more tonight — best food, biggest discount, or closest?"
  "taking my wife out" → "romantic, quiet, or just really good food?"
  hotel search → "do you usually have a hotel brand you prefer?"
  car rental → "economy, sedan, or SUV?" then later "price, comfort, or luggage space?"
  trip mention → "solo, with your spouse, or family?"
  gift ask → "about how much — under $25, around $50, around $100?"
  first gift chat → names/ages/interests of the grandkids ("I can remember them so gift
  ideas get better over time") — but spread over the conversation, never a questionnaire.
Never hold the answer hostage to a question. Never ask two personalization questions in
one message. If the member ignores a question, drop it — curious, never interrogating.
When a known preference makes the choice obvious, use it instead of asking again:
"SUV again? Last time you wanted extra luggage space."

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
from every message — home city, family, destinations, brands and cuisines, upcoming
trips, important dates. Use kind=profile for long-lived facts, kind=episodic (with
expires) for current events like trips.

ATOMIC memories — one fact per remember call, never a bundle. For people, key the
memory to the person so each fact updates independently:
  key=family_member value="granddaughter Emma, about 6"
  key=interest:Emma value="Barbie"
  key=interest:Noah value="soccer"
  key=gift_budget:Noah value="around $50"
  key=spouse value="wife Susan, likes flowers"
Children's interests change fast: when a gift occasion for a known child comes up
months later, check — "Last time Noah was really into science. Still true, or is he
into something different now?" — then forget the old interest and remember the new one.
After a redemption at a brand, confirm before inferring loyalty: "Should I remember
that you like Outback, or was this just a one-off?"

Explicit statements → source=explicit, confidence 0.9-1.0. Strong inference → 0.85.
Moderate → 0.65. Weak → 0.4-0.5, and never assert weak inferences back as facts
("It looks like you might…" / ask instead).
Reference memory naturally and sparingly: "Since you mentioned…", "I remembered…".
If asked "what do you remember about me", list it plainly and note they can ask you to
change or forget anything.

If the member sends a screenshot or photo of something they're about to buy or book
(a hotel page, a rental quote, a product), identify the merchant/product and check
benefits for it before they spend (search_benefits / search_local_restaurants).
If they paste a quote like "Hertz rental $384", same thing — check before they book.

Household questions ("does this work for my husband too?"): AARP membership covers the
member and, for most discounts, their household — but eligibility varies per offer, so
point at the offer's terms via its link rather than promising.

If the member asks for a human ("talk to someone"), give AARP member support:
1-888-687-2277, and don't make them fight the bot.

Rewards balances, saved-benefit history and member-specific eligibility need a linked
AARP account. If the member isn't linked yet (see profile) and you want to offer linking,
you MUST call get_link_url and paste the actual url it returns on its own line. NEVER
write "here's the link" (or similar) without the real url in the same message — a link
you promised but didn't include is a broken reply. Same rule for every benefit: if you
mention a link, the actual url from the tool must be in the text. This prototype uses demo Rewards data — say so when asked about points.
Never request passwords over iMessage.

Light onboarding (§36): after you've delivered first value to a new member, you may ask
ONE short personalization question ("Want me to personalize what I find? What matters
most — travel, restaurants, shopping?"). Never a questionnaire.

For "near me" requests use search_local_restaurants — it needs a ZIP code; if you
don't know theirs (check home_location in memory), ask for it, then remember it.
Local offers redeem in person or by printed coupon — say so.

For AARP Rewards questions (points, expiring, redeeming, earning) use get_rewards.
For "what am I missing?" / "anything good for me?" use get_opportunities and frame the
answer around what you know about them.

Member controls (honor immediately, confirm briefly): a bare "reset" / "start over" /
"forget everything" means reset_everything — just do it, don't offer a menu.
"don't send restaurant offers" → mute_category. "stop watching X" → remove_watch. "forget X" → forget. A savings goal
("help me save $500 this year") → set_savings_goal; report progress when asked.

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
    description: "The member's savings summary (total + by category + goal progress).",
    input_schema: { type: "object", properties: {} } },
  { name: "search_local_restaurants",
    description: "LIVE nearby restaurant offers from AARP's local network (memberoffers.aarp.org). Requires a 5-digit ZIP. Optional keyword ('pizza', 'steakhouse') and distance in miles (default 5). Offers redeem in person/print.",
    input_schema: { type: "object", properties: {
      zip: { type: "string" }, keyword: { type: "string" },
      distance: { type: "number" } }, required: ["zip"] } },
  { name: "get_rewards",
    description: "AARP Rewards summary: points balance, points expiring soon, best redemption options (ranked by the member's learned preference), quick earning opportunities.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_opportunities",
    description: "'What am I missing?' / 'anything good for me?' — the member's biggest unused opportunities: benefits matching their remembered preferences in categories they haven't redeemed in yet.",
    input_schema: { type: "object", properties: {} } },
  { name: "set_savings_goal",
    description: "Member set a savings goal, e.g. 'help me save $500 this year'.",
    input_schema: { type: "object", properties: { target: { type: "number" } }, required: ["target"] } },
  { name: "reset_everything",
    description: "Wipe everything remembered about this member — memories, trips, watches, saved benefits, savings history — and start fresh. Use when the member says 'reset', 'start over', 'forget everything', or 'clear my data'. Confirm briefly afterward.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_link_url",
    description: "The member's secure account-linking URL (§37). Offer it when they want Rewards/saved history and aren't linked yet.",
    input_schema: { type: "object", properties: {} } },
  { name: "set_weekly_digest",
    description: "Turn the opt-in weekly savings digest on or off (§38). Only enable when the member clearly asks for a weekly summary.",
    input_schema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] } },
  { name: "mute_category",
    description: "Member asked to stop a category ('don't send restaurant offers'). Category slugs: restaurants, travel, entertainment, insurance, healthandwellness, shoppingandgroceries, autoservice, finances, home-tech.",
    input_schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] } },
];

/** Execute one tool call against the member's store. May return a promise. */
export function invokeTool(name, input, store, now, deps = {}) {
  switch (name) {
    case "search_local_restaurants": {
      const fn = deps.searchLocal || searchLocalRestaurants;
      return fn({ zip: input.zip, keyword: input.keyword || "", distance: input.distance || 5, limit: 6 })
        .then((r) => (r.offers.length ? r : { ...r, note: "No local offers found in that area — say so plainly." }))
        .catch((e) => ({ error: `local search unavailable (${e.message}) — offer the national restaurant benefits instead` }));
    }
    case "get_rewards": return getRewards(store, now);
    case "get_opportunities": {
      const ctx = store.rankingContext(now);
      const redeemedCats = new Set(store.state.savings_events.map((e) =>
        loadCatalog().benefits.find((b) => b.id === e.benefit_id)?.category).filter(Boolean));
      const mems = store.activeMemories(now).filter((m) => m.confidence >= 0.5);
      const queries = mems.map((m) => String(m.value)).slice(0, 6);
      const picks = [];
      for (const q of queries.length ? queries : ["travel", "restaurants"]) {
        const hits = searchBenefits(q, ctx, { limit: 2 });
        for (const h of hits) {
          if (!redeemedCats.has(h.benefit.category) && !picks.some((p) => p.id === h.benefit.id)) {
            picks.push({ ...benefitCard(h.benefit, store.state.member_id), because: q });
          }
        }
      }
      return { unused_opportunities: picks.slice(0, 4),
        note: picks.length ? "Frame each around the memory in 'because'." : "Nothing strong — say so honestly." };
    }
    case "set_savings_goal":
      store.state.savings_goal = { target: input.target, set_at: now };
      store.save();
      return { ok: true, target: input.target, saved_so_far: store.totalSaved() };
    case "reset_everything": { store.reset(now); return { ok: true, note: "Everything cleared. Confirm warmly in one short line and invite them to start." }; }
    case "get_link_url": {
      const pub = process.env.AARP_PUBLIC_URL || "";
      return { url: `${pub.replace(/\/$/, "")}/link/${memberHash(store.state.member_id)}`,
        linked: !!store.state.linked };
    }
    case "set_weekly_digest": {
      store.state.weekly_digest = !!input.enabled; store.save();
      return { ok: true, weekly_digest: store.state.weekly_digest };
    }
    case "mute_category": { store.muteCategory(input.category); return { ok: true, muted: store.state.muted_categories }; }
    case "search_benefits": {
      const results = searchBenefits(input.query, store.rankingContext(now),
        input.category ? { categories: [input.category] } : {});
      const cards = results.map((r) => benefitCard(r.benefit, store.state.member_id));
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
        benefits_used: store.state.savings_events.length,
        goal: store.state.savings_goal
          ? { target: store.state.savings_goal.target, progress: store.totalSaved() }
          : null };
    }
    default: return { error: `unknown tool ${name}` };
  }
}

function systemPrompt(store, now, configWhich = "published") {
  let configSection = "";
  try { configSection = "\n\n" + renderConfigPrompt(getConfig(configWhich)); } catch { /* config optional */ }
  const p = store.profileSummary(now);
  const profile = [
    `Account: ${p.linked ? "linked" : "NOT linked"}`,
    p.home_location ? `Home: ${p.home_location}` : null,
    ...p.memory_lines, ...p.trip_lines, ...p.watch_lines,
    p.saved_benefits.length ? `Saved benefits: ${p.saved_benefits.join(", ")}` : null,
    p.total_saved ? `Total saved this year: $${p.total_saved.toFixed(0)}` : null,
  ].filter(Boolean).join("\n") || "(new member — nothing learned yet)";
  return PERSONA.replace("{{TODAY}}", now.slice(0, 10)).replace("{{PROFILE}}", profile) + configSection;
}

/** Anthropic Messages API tool loop. */
async function anthropicTurn(store, userText, now, history, images = [], opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — use AARP_PROVIDER=fake or supply a key");
  const userContent = images.length
    ? [...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })),
       { type: "text", text: userText }]
    : userText;
  const messages = [...history, { role: "user", content: userContent }];
  for (let round = 0; round < 6; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: systemPrompt(store, now, opts.configWhich || "published"),
        tools: TOOLS, messages }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = await res.json();
    const toolUses = msg.content.filter((c) => c.type === "tool_use");
    if (msg.stop_reason === "max_tokens" && toolUses.length) {
      // Truncated mid-tool-call (e.g. many remember calls in one turn): drop the
      // incomplete calls, keep any complete ones, and let the loop continue.
      msg.content = msg.content.filter((c) => c.type !== "tool_use" || c.input !== undefined);
    }
    if (!toolUses.length || (msg.stop_reason !== "tool_use" && msg.stop_reason !== "max_tokens")) {
      const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) return text;
      // A tool-heavy turn can end with no prose — one more round to compose the reply.
      messages.push({ role: "assistant", content: msg.content.length ? msg.content : [{ type: "text", text: "…" }] });
      messages.push({ role: "user", content: "(Reply to the member now in plain text — summarize what you found or noted.)" });
      continue;
    }
    messages.push({ role: "assistant", content: msg.content });
    const results = [];
    for (const tu of toolUses) {
      const out = await invokeTool(tu.name, tu.input, store, now);
      opts.trace?.tool_calls.push({ tool: tu.name, input: tu.input,
        result_summary: JSON.stringify(out).slice(0, 300) });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
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
export async function converse(memberId, userText, { now = new Date().toISOString(), provider = process.env.AARP_PROVIDER || "anthropic", membersDir, images = [], useDraft = false, withTrace = false } = {}) {
  const store = new MemberStore(memberId, membersDir);
  const memIdsBefore = new Set(store.activeMemories(now).map((m) => m.id));
  const trace = withTrace ? { tool_calls: [], memories_used: store.profileSummary(now).memory_lines } : null;
  store.logMessage("member", userText, now);
  const history = store.state.message_log.slice(0, -1).slice(-12)
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({ role: m.role === "member" ? "user" : "assistant", content: m.text }));
  let reply = provider === "fake"
    ? fakeTurn(store, userText, now)
    : await anthropicTurn(store, userText, now, history, images,
        { configWhich: useDraft ? "draft" : "published", trace });
  if (!reply || !reply.trim()) {
    reply = "Got it — noted! What else can I help you find?";
  }
  store.logMessage("concierge", reply, now);
  if (!withTrace) return reply;
  const fresh = new MemberStore(memberId, membersDir);
  const memories_created = fresh.activeMemories(now)
    .filter((m) => !memIdsBefore.has(m.id))
    .map((m) => `${m.key}: ${m.value}`);
  return { reply, trace: { ...trace, memories_created,
    config: useDraft ? "draft" : "published" } };
}
