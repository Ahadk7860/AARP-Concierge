// Agent configuration as data — Builder MVP PRD §§6, 30-31.
//
// v3 (adds purchase steps to Gifts): the config carries the design's exact model — five flows with typed steps
// (Memory / Ask / Search / Respond / Action) and five memory groups — so the
// builder UI is one-to-one with the approved design. Draft is edited/tested;
// published powers the live Photon agent; publish copies draft → published.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = () => process.env.AARP_CONFIG_PATH || join(HERE, "..", "data", "agent-config.json");
const VERSION = 3;

export const DEFAULT_CONFIG = {
  agent: { name: "AARP Concierge", description: "Concierge agent for AARP members, connected to iMessage." },
  flows: [
    { id: "food", name: "Food & Restaurants", status: "Live",
      description: "Helps users find dining offers and learns what they like.",
      trigger: "the user asks about food or restaurants",
      steps: [
        { id: "loc", type: "Memory", label: "Get location", sub: "Reads Member → Home location", field: "Member → Home location", note: "If the location is missing, the agent asks for it before searching." },
        { id: "pref", type: "Memory", label: "Check food preferences", sub: "Reads Food → Cuisine", field: "Food → Cuisine", note: "Read before asking, so the agent never asks something it already knows." },
        { id: "ask", type: "Ask", label: "Ask preference if needed", question: "What are you feeling tonight?", choices: ["Italian", "Steak", "Casual", "Something else"], ask_when: "Only if we do not already know their food preference", remember: true, save_to: "Food → Preferred cuisine" },
        { id: "search", type: "Search", label: "Search AARP benefits", sub: "Searches Restaurant Offers", field: "Restaurant Offers", note: "Only verified, currently active offers are returned. Use search_local_restaurants (needs ZIP) for nearby, search_benefits for chains." },
        { id: "respond", type: "Respond", label: "Recommend 3 options", sub: "Concierge tone, three options max", field: "Three options", note: "The agent explains why each option fits." },
        { id: "write", type: "Memory", label: "Remember useful preferences", sub: "Writes Food → Cuisine", field: "Food → Cuisine", note: "Saved only when the user states or picks a preference." },
      ] },
    { id: "travel", name: "Travel", status: "Live",
      description: "Plans trips and surfaces travel benefits.",
      trigger: "the user asks about travel",
      steps: [
        { id: "ask-dest", type: "Ask", label: "Ask destination or mood", question: "What are you feeling?", choices: ["Warm beach", "City", "Nature", "Cruise", "Visiting family"], ask_when: "Only when they want to travel but have no destination in mind", remember: true, save_to: "Travel → Destinations" },
        { id: "check", type: "Memory", label: "Check travel preferences", sub: "Reads Travel → Hotels, Rental car", field: "Travel → Hotel preference", note: "Used to shape which benefits are shown." },
        { id: "ask-need", type: "Ask", label: "Ask what they still need", question: "What still needs booking?", choices: ["Flight", "Hotel", "Rental car", "Nothing yet"], ask_when: "Only if the trip details are incomplete", remember: false, save_to: "Travel → Destinations" },
        { id: "search", type: "Search", label: "Search travel benefits", sub: "Searches AARP Benefits", field: "AARP Benefits", note: "Filtered to the destination and dates on file." },
        { id: "respond", type: "Respond", label: "Recommend options", sub: "Two to three options", field: "Three options", note: "" },
        { id: "write", type: "Memory", label: "Remember travel preferences", sub: "Writes Travel → Destinations", field: "Travel → Destinations", note: "Store recurring patterns (e.g. Hawaii every January) and the trip itself (add_trip)." },
      ] },
    { id: "gifts", name: "Gifts", status: "Draft",
      description: "Helps users choose gifts and remembers who they are for.",
      trigger: "the user asks for gift help",
      steps: [
        { id: "who", type: "Ask", label: "Ask who the gift is for", question: "Who are you shopping for?", choices: ["Spouse", "Child", "Grandchild", "Friend"], ask_when: "Always, unless the recipient is stated", remember: true, save_to: "Family → Person" },
        { id: "known", type: "Memory", label: "Check if we know that person", sub: "Reads Family → Person", field: "Family → Person", note: "Skips the next two questions when the person is already known. Re-validate stale child interests: 'Last time you told me Emma was really into horses. Is she still into that?'" },
        { id: "age", type: "Ask", label: "Ask age if needed", question: "How old are they?", choices: ["Under 5", "5–12", "Teen", "Adult"], ask_when: "Only if we do not already know their age", remember: true, save_to: "Family → Person → Age" },
        { id: "interests", type: "Ask", label: "Ask interests", question: "What are they into right now?", choices: ["Sports", "Arts & crafts", "Science", "Games"], ask_when: "Only if we do not already know their interests", remember: true, save_to: "Family → Person → Interests" },
        { id: "budget", type: "Ask", label: "Ask budget", question: "Roughly what budget?", choices: ["Under $25", "$25–50", "$50–100", "No limit"], ask_when: "Always", remember: true, save_to: "Shopping → Budget" },
        { id: "search", type: "Search", label: "Search relevant offers", sub: "Searches AARP Benefits + products", field: "AARP Benefits", note: "search_products finds real purchasable items; some carry AARP discounts." },
        { id: "respond", type: "Respond", label: "Recommend gifts", sub: "Three options with reasoning", field: "Three options", note: "Be honest when the catalog has nothing gift-specific." },
        { id: "checkout", type: "Action", label: "Prepare checkout", sub: "Calls prepare_checkout", field: "prepare_checkout", note: "Builds the immutable purchase proposal with exact totals, card, and destination." },
        { id: "confirm", type: "Action", label: "Request confirmation — LOCKED ON", sub: "Reply BUY to place this exact order", field: "request_purchase_confirmation", note: "Always shows exact total, merchant, quantity, payment method, and shipping destination. Explicit confirmation cannot be disabled." },
        { id: "purchase", type: "Action", label: "Purchase after BUY", sub: "Calls submit_checkout", field: "submit_checkout", note: "Fails with PURCHASE_NOT_AUTHORIZED unless the member explicitly approved this exact proposal." },
        { id: "track", type: "Action", label: "Track order", sub: "Calls get_order_status", field: "get_order_status", note: "Order, savings, and delivery estimate are recorded." },
        { id: "write", type: "Memory", label: "Remember recipient preferences", sub: "Writes Family → Person", field: "Family → Person → Interests", note: "One atomic memory per fact: relationship, name, age, each interest, budget." },
      ] },
    { id: "car", name: "Car Rental", status: "Live",
      description: "Finds rental benefits and remembers the car type they like.",
      trigger: "the user needs a rental car",
      steps: [
        { id: "check", type: "Memory", label: "Check existing car preference", sub: "Reads Travel → Rental car", field: "Travel → Rental car preference", note: "When known, confirm instead of re-asking: 'SUV again? Last time you wanted extra luggage space.'" },
        { id: "ask", type: "Ask", label: "Ask car type if unknown", question: "What kind of car are you looking for?", choices: ["Economy", "Sedan", "SUV", "Family-size"], ask_when: "Only if we do not already know their car preference", remember: true, save_to: "Travel → Rental car preference" },
        { id: "search", type: "Search", label: "Search rental benefits", sub: "Searches AARP Benefits", field: "AARP Benefits", note: "" },
        { id: "respond", type: "Respond", label: "Recommend option", sub: "One clear recommendation", field: "One option", note: "" },
        { id: "write", type: "Memory", label: "Remember car preference", sub: "Writes Travel → Rental car", field: "Travel → Rental car preference", note: "" },
      ] },
    { id: "rewards", name: "Rewards", status: "Live",
      description: "Answers points questions and suggests ways to use them.",
      trigger: "the user asks about points or rewards",
      steps: [
        { id: "balance", type: "Action", label: "Get rewards balance", sub: "Calls Get Rewards Balance", field: "Get Rewards Balance", note: "Demo Rewards data until the member links their account — always say so." },
        { id: "search", type: "Search", label: "Search reward offers", sub: "Searches AARP Benefits", field: "AARP Benefits", note: "" },
        { id: "respond", type: "Respond", label: "Show balance and options", sub: "Balance first, then two suggestions", field: "Two options", note: "" },
        { id: "write", type: "Memory", label: "Remember redemption preference", sub: "Writes Shopping → Gift preferences", field: "Shopping → Gift preferences", note: "" },
      ] },
  ],
  memory_schema: [
    { id: "family", label: "Family", fields: [
      { key: "family.spouse", label: "Spouse", learn: true, ask: false, personalize: true,
        desc: "The member's spouse — name and preferences they mention (likes flowers, favorite cuisine).", followup: "" },
      { key: "family.children", label: "Children", learn: true, ask: true, personalize: true,
        desc: "Children — names and relevant context.", followup: "How old are they now?" },
      { key: "family.grandchildren", label: "Grandchildren", learn: true, ask: true, personalize: true,
        desc: "Names, ages, and interests of the user's grandchildren. Children's interests change fast — re-validate before gift occasions.", followup: "How old are they now?" },
    ] },
    { id: "food", label: "Food", fields: [
      { key: "food.cuisine", label: "Cuisine", learn: true, ask: true, personalize: true,
        desc: "Types of food the user says they like, or orders repeatedly.", followup: "Is that usually your go-to?" },
      { key: "food.restaurants", label: "Favorite restaurants", learn: true, ask: false, personalize: true,
        desc: "Brands the member likes — confirm after redemptions rather than inferring from one visit.", followup: "" },
      { key: "food.preference", label: "Dining preference", learn: true, ask: false, personalize: true,
        desc: "Quality vs biggest discount vs closest.", followup: "" },
    ] },
    { id: "travel", label: "Travel", fields: [
      { key: "travel.destinations", label: "Preferred destinations", learn: true, ask: true, personalize: true,
        desc: "Places the user visits often or says they enjoy traveling to.", followup: "Do you go there often?" },
      { key: "travel.hotel", label: "Hotel preference", learn: true, ask: false, personalize: true,
        desc: "Preferred hotel brands and how strongly they prefer them.", followup: "" },
      { key: "travel.car", label: "Rental car preference", learn: true, ask: true, personalize: true,
        desc: "Vehicle type and what matters most (price, comfort, luggage space).", followup: "What kind of car do you usually rent?" },
    ] },
    { id: "shopping", label: "Shopping", fields: [
      { key: "shopping.gifts", label: "Gift preferences", learn: true, ask: true, personalize: true,
        desc: "Who they buy gifts for and what has worked.", followup: "" },
      { key: "shopping.budget", label: "Budget", learn: false, ask: true, personalize: true,
        desc: "Typical per-recipient gift budgets.", followup: "Roughly what budget?" },
    ] },
    { id: "interests", label: "Interests", fields: [
      { key: "interests.golf", label: "Golf", learn: true, ask: false, personalize: true, desc: "Whether the member plays golf and how often.", followup: "" },
      { key: "interests.movies", label: "Movies", learn: true, ask: false, personalize: true, desc: "Movie tastes — genres, who they go with.", followup: "" },
      { key: "interests.other", label: "Other", learn: true, ask: false, personalize: true, desc: "Any other hobby or interest that could make a benefit relevant.", followup: "" },
    ] },
  ],
};

function load() {
  const p = CONFIG_PATH();
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8"));
      if (s.version === VERSION) return s;
      // schema migration: v1 (or unversioned) configs are replaced by the v2 default
    } catch { /* fall through */ }
  }
  return { version: VERSION, draft: structuredClone(DEFAULT_CONFIG), published: structuredClone(DEFAULT_CONFIG),
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

export function updateDraftStep(flowId, stepId, patch) {
  const s = load();
  const flow = s.draft.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`unknown flow ${flowId}`);
  const step = flow.steps.find((st) => st.id === stepId);
  if (!step) throw new Error(`unknown step ${stepId}`);
  const EDITABLE = ["question", "choices", "ask_when", "remember", "save_to", "label", "sub", "note", "field"];
  for (const k of EDITABLE) if (k in patch) step[k] = patch[k];
  if (step.type === "Ask" && "question" in patch) step.sub = `“${step.question}”`;
  s.draft_updated_at = new Date().toISOString();
  save(s);
  return step;
}

export function updateDraftMemoryField(key, patch) {
  const s = load();
  for (const g of s.draft.memory_schema) {
    const f = g.fields.find((x) => x.key === key);
    if (f) {
      for (const k of ["label", "desc", "learn", "ask", "personalize", "followup"]) if (k in patch) f[k] = patch[k];
      s.draft_updated_at = new Date().toISOString();
      save(s);
      return f;
    }
  }
  throw new Error(`unknown memory field ${key}`);
}

export function pendingChanges() {
  const s = load();
  const changes = [];
  for (const df of s.draft.flows) {
    const pf = s.published.flows.find((f) => f.id === df.id);
    if (!pf) { changes.push(`New flow: ${df.name}`); continue; }
    if (JSON.stringify(df) !== JSON.stringify(pf)) changes.push(`${df.name} flow updated`);
  }
  for (const dg of s.draft.memory_schema) {
    const pg = s.published.memory_schema.find((g) => g.id === dg.id);
    if (JSON.stringify(dg) !== JSON.stringify(pg)) changes.push(`${dg.label} memory updated`);
  }
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

/** Config → system-prompt sections. The seam through which builder edits drive
 * the live agent's behavior. */
export function renderConfigPrompt(config) {
  const lines = [];
  lines.push("CONFIGURED FLOWS — these are the owner-defined behaviors. Follow them.");
  for (const f of config.flows) {
    lines.push(`\n## ${f.name} — when ${f.trigger}`);
    for (const st of f.steps) {
      if (st.type === "Ask" && st.question) {
        lines.push(`- ASK: "${st.question}"${st.choices?.length ? ` (suggest: ${st.choices.join(" / ")})` : ""}`);
        if (st.ask_when) lines.push(`  ask when: ${st.ask_when}`);
        if (st.remember && st.save_to) lines.push(`  remember the answer → key "${st.save_to}" (source=explicit)`);
      } else if (st.type === "Memory") {
        lines.push(`- ${st.label}${st.note ? `: ${st.note}` : ` (${st.sub || st.field})`}`);
      } else if (st.type === "Search" || st.type === "Action") {
        lines.push(`- ${st.label}${st.note ? `: ${st.note}` : ""}`);
      } else if (st.type === "Respond") {
        lines.push(`- ${st.label}${st.sub ? ` — ${st.sub}` : ""}${st.note ? `. ${st.note}` : ""}`);
      }
    }
  }
  lines.push("\nMEMORY SCHEMA — what you may learn about each member (use these keys with the remember tool):");
  for (const g of config.memory_schema) {
    for (const fld of g.fields) {
      if (!fld.learn && !fld.ask) continue;
      lines.push(`- ${fld.key}: ${fld.desc}${fld.ask && fld.followup ? ` May ask: "${fld.followup}"` : ""}${fld.learn ? "" : " (only from direct answers — do not extract)"}${fld.personalize ? "" : " (do NOT use for personalization)"}`);
    }
  }
  return lines.join("\n");
}
