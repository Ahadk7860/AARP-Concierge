// Agent configuration as data — Builder MVP PRD §§6, 30-31.
//
// The builder edits DRAFT; Test Agent runs DRAFT; the live Photon runtime runs
// PUBLISHED. Publish copies draft → published (no version control in MVP).
// Flows + memory schema are rendered into the agent's system prompt, which is how
// "configuration" changes the behavior of an LLM-driven agent.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = () => process.env.AARP_CONFIG_PATH || join(HERE, "..", "data", "agent-config.json");

export const DEFAULT_CONFIG = {
  agent: { name: "AARP Concierge", description: "Concierge agent for AARP members." },
  flows: [
    {
      id: "food", name: "Food & Restaurants", status: "live",
      description: "Finds restaurants and relevant benefits, and learns dining preferences.",
      trigger_description: "The member asks about food, dinner, lunch, restaurants, eating out, or a date night.",
      steps: [
        { id: "food-context", type: "understand", label: "Check known food preferences",
          instructions: "Check memory for location, preferred cuisine, favorite restaurants, and dining priority before asking anything." },
        { id: "food-ask-cuisine", type: "ask", label: "Ask cuisine if unknown",
          question: "What are you feeling tonight?",
          options: ["Italian", "Steak", "Asian", "Casual", "Something else"],
          ask_when: "Only if we don't already know their food preference and the request is broad.",
          remember: true, memory_field: "food.preferred_cuisine" },
        { id: "food-search", type: "do", label: "Search AARP restaurant benefits",
          action: "search_benefits / search_local_restaurants (ZIP required for nearby)" },
        { id: "food-respond", type: "do", label: "Recommend up to 3 options",
          instructions: "Lead with the best personal match and say why. Include redemption links." },
        { id: "food-remember", type: "remember", label: "Remember useful preferences",
          instructions: "Store cuisine/brand preferences the member expressed. After a redemption, confirm brand loyalty before inferring it." },
      ],
    },
    {
      id: "travel", name: "Travel", status: "live",
      description: "Plans trips and finds travel benefits; learns destinations and travel style.",
      trigger_description: "The member mentions a trip, destination, hotel, flight, cruise, or rental car.",
      steps: [
        { id: "travel-context", type: "understand", label: "Check existing travel memory",
          instructions: "Look for known destinations, hotel/car preferences, travel style, and upcoming trips." },
        { id: "travel-ask-style", type: "ask", label: "Ask trip type if destination unknown",
          question: "What are you feeling?",
          options: ["Warm beach", "City trip", "Nature", "Cruise", "Visiting family"],
          ask_when: "Only when the member wants to travel but has no destination in mind.",
          remember: true, memory_field: "travel.travel_style" },
        { id: "travel-ask-needs", type: "ask", label: "Ask what they still need",
          question: "What do you still need — hotel, rental car, restaurants, things to do?",
          ask_when: "When a specific trip is coming up.", remember: false },
        { id: "travel-search", type: "do", label: "Search AARP travel benefits",
          action: "search_benefits (hotels, car rentals, flights, cruises)" },
        { id: "travel-remember", type: "remember", label: "Remember travel preferences",
          instructions: "Store destinations, recurring patterns (e.g. Hawaii every January), hotel and car preferences, and the trip itself (add_trip)." },
      ],
    },
    {
      id: "gifts", name: "Gifts", status: "draft",
      description: "Helps members choose gifts for family; learns each recipient over time.",
      trigger_description: "The member asks for gift help — birthdays, Christmas, grandkids, spouse.",
      steps: [
        { id: "gifts-who", type: "ask", label: "Who is the gift for?",
          question: "Sure — who are you shopping for?",
          ask_when: "When the recipient isn't stated or known.", remember: false },
        { id: "gifts-person", type: "understand", label: "Check if we know that person",
          instructions: "If the recipient is known, use their remembered age/interests, and re-validate stale interests: 'Last time you told me Emma was really into horses. Is she still into that?'" },
        { id: "gifts-ask-details", type: "ask", label: "Learn name, age, interests naturally",
          question: "What are they into right now?",
          ask_when: "Only for unknown details, one question at a time — never a questionnaire.",
          remember: true, memory_field: "family.interest" },
        { id: "gifts-ask-budget", type: "ask", label: "Ask budget",
          question: "About how much are you thinking — under $25, around $50, around $100?",
          ask_when: "When budget for this recipient is unknown.",
          remember: true, memory_field: "shopping.gift_budget" },
        { id: "gifts-search", type: "do", label: "Search relevant AARP offers",
          action: "search_benefits (shopping, flowers & gifts, entertainment)" },
        { id: "gifts-remember", type: "remember", label: "Remember the person",
          instructions: "Store each person atomically: relationship, name, approximate age, interests, budget. Update interests when they change (children's interests expire fast)." },
      ],
    },
  ],
  memory_schema: [
    { group: "Family", fields: [
      { key: "family.member", label: "Relationship & name", learn: true, ask: true, personalize: true,
        description: "Spouse, children, grandchildren — relationship and name (e.g. 'granddaughter Emma, about 7')." },
      { key: "family.interest", label: "Interests", learn: true, ask: true, personalize: true,
        description: "What each family member is into right now. Children's interests change fast — re-validate before gift occasions.",
        followup: "What are they into right now?" },
    ]},
    { group: "Food", fields: [
      { key: "food.preferred_cuisine", label: "Preferred cuisine", learn: true, ask: true, personalize: true,
        description: "Cuisines the member says they like.", followup: "What kinds of food do you usually like?" },
      { key: "food.favorite_restaurants", label: "Favorite restaurants", learn: true, ask: false, personalize: true,
        description: "Brands the member likes — confirm after redemptions rather than inferring from one visit." },
      { key: "food.dining_priority", label: "Dining priority", learn: true, ask: true, personalize: true,
        description: "Quality vs biggest discount vs closest.", followup: "What matters more — best food, biggest discount, or closest?" },
    ]},
    { group: "Travel", fields: [
      { key: "travel.destination", label: "Destinations", learn: true, ask: true, personalize: true,
        description: "Places the member visits or plans repeatedly.", followup: "Do you go there often? I can remember that." },
      { key: "travel.hotel_preference", label: "Hotel preference", learn: true, ask: true, personalize: true,
        description: "Preferred hotel brands.", followup: "Do you usually have a hotel brand you prefer?" },
      { key: "travel.car_preference", label: "Rental-car preference", learn: true, ask: true, personalize: true,
        description: "Vehicle type and what matters (price, comfort, luggage space)." },
      { key: "travel.travel_style", label: "Travel style", learn: true, ask: true, personalize: true,
        description: "Beach vs city vs nature vs cruise; solo vs family." },
    ]},
    { group: "Shopping", fields: [
      { key: "shopping.gift_budget", label: "Typical gift budget", learn: true, ask: true, personalize: true,
        description: "Per-recipient budgets (e.g. 'around $50 for Noah')." },
    ]},
  ],
};

function load() {
  const p = CONFIG_PATH();
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* fall through */ }
  }
  return { draft: structuredClone(DEFAULT_CONFIG), published: structuredClone(DEFAULT_CONFIG),
    draft_updated_at: null, published_at: null };
}

function save(state) {
  const p = CONFIG_PATH();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 1));
}

export function getConfig(which = "published") {
  const s = load();
  return which === "draft" ? s.draft : s.published;
}

export function getState() { return load(); }

export function saveDraft(draft) {
  const s = load();
  s.draft = draft;
  s.draft_updated_at = new Date().toISOString();
  save(s);
  return s;
}

/** Update one step of one flow in the draft (the MVP's core edit operation). */
export function updateDraftStep(flowId, stepId, patch) {
  const s = load();
  const flow = s.draft.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`unknown flow ${flowId}`);
  const step = flow.steps.find((st) => st.id === stepId);
  if (!step) throw new Error(`unknown step ${stepId}`);
  const EDITABLE = ["question", "options", "ask_when", "remember", "memory_field", "instructions", "label"];
  for (const k of EDITABLE) if (k in patch) step[k] = patch[k];
  s.draft_updated_at = new Date().toISOString();
  save(s);
  return step;
}

export function updateDraftMemoryField(key, patch) {
  const s = load();
  for (const g of s.draft.memory_schema) {
    const f = g.fields.find((x) => x.key === key);
    if (f) {
      for (const k of ["label", "description", "learn", "ask", "personalize", "followup"]) if (k in patch) f[k] = patch[k];
      s.draft_updated_at = new Date().toISOString();
      save(s);
      return f;
    }
  }
  throw new Error(`unknown memory field ${key}`);
}

/** Human-readable diff summary for the publish dialog. */
export function pendingChanges() {
  const s = load();
  const changes = [];
  for (const df of s.draft.flows) {
    const pf = s.published.flows.find((f) => f.id === df.id);
    if (!pf) { changes.push(`New flow: ${df.name}`); continue; }
    if (JSON.stringify(df) !== JSON.stringify(pf)) changes.push(`${df.name} flow updated`);
  }
  if (JSON.stringify(s.draft.memory_schema) !== JSON.stringify(s.published.memory_schema)) changes.push("Memory schema updated");
  if (JSON.stringify(s.draft.agent) !== JSON.stringify(s.published.agent)) changes.push("Agent identity updated");
  return changes;
}

export function publish() {
  const s = load();
  const changes = pendingChanges();
  s.published = structuredClone(s.draft);
  s.published_at = new Date().toISOString();
  save(s);
  return { published_at: s.published_at, changes };
}

/** Render flows + memory schema into system-prompt sections. This is the seam
 * through which builder configuration drives the live agent's behavior. */
export function renderConfigPrompt(config) {
  const lines = [];
  lines.push("CONFIGURED FLOWS — these are the owner-defined behaviors. Follow them.");
  for (const f of config.flows) {
    lines.push(`\n## ${f.name} — trigger: ${f.trigger_description}`);
    for (const st of f.steps) {
      if (st.type === "ask" && st.question) {
        lines.push(`- ASK: "${st.question}"${st.options?.length ? ` (suggest: ${st.options.join(" / ")})` : ""}`);
        if (st.ask_when) lines.push(`  ask when: ${st.ask_when}`);
        if (st.remember && st.memory_field) lines.push(`  remember the answer → key "${st.memory_field}" (source=explicit)`);
      } else if (st.instructions) {
        lines.push(`- ${st.label}: ${st.instructions}`);
      } else if (st.action) {
        lines.push(`- ${st.label}: use ${st.action}`);
      } else {
        lines.push(`- ${st.label}`);
      }
    }
  }
  lines.push("\nMEMORY SCHEMA — what you may learn about each member (use these keys with the remember tool):");
  for (const g of config.memory_schema) {
    for (const fld of g.fields) {
      if (!fld.learn) continue;
      lines.push(`- ${fld.key}: ${fld.description}${fld.ask && fld.followup ? ` May ask: "${fld.followup}"` : ""}${fld.personalize ? "" : " (do NOT use for personalization)"}`);
    }
  }
  return lines.join("\n");
}
