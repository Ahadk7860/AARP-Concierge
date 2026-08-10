// The verifier (V3_ARCHITECTURE.md §2, I1, I2) — the single most important file in Track B.
//
// I1: the verifier runs on every agent reply. No path bypasses it — `runVerifiedTurn`
// below is the only sanctioned way to turn agent prose into something delivered, and the
// agent loop (agent-loop.ts) has no other exit.
//
// I2: every person-name, handle, date, and number in the output must appear in a tool
// result from THIS turn. This module treats that literally: it builds an evidence pool
// from the tool call outputs of the current turn only (never a prior turn, never model
// "knowledge"), extracts candidate factual atoms from the generated text, and rejects any
// atom that cannot be found in the pool.
//
// Failure mode discipline: this gate is intentionally over-inclusive on what counts as a
// "claim" (see extractClaims). A false positive costs a wasted regenerate or an unnecessary
// degrade — annoying, never dangerous. A false negative ships a fabrication. When in doubt,
// this file flags.
//
// Violation → ONE regenerate that names the violation → then degrade to a grounded summary
// built directly from evidence (never from free model text again).
//
// KNOWN CEILING (write this down rather than let it be rediscovered): this verifies that
// claimed atoms APPEAR in this turn's tool output, not that the RELATION asserted between
// them holds. "Sarah owes you a reply" passes verification whenever "Sarah" appears
// anywhere in this turn's evidence, even in a snippet about something else entirely. That
// is what I2 literally specifies ("must appear in a tool result from this turn"), so it is
// in scope for v3 as written — but it is a real ceiling on what this gate catches, not a
// gap in the implementation below.
//
// THE `general` TOOL AND I2 (added alongside tools.ts's `general` implementation): `general`
// (§2 "model knowledge / web") answers from the model's own training knowledge, not from any
// person-bearing store — its evidence source is "general", never `relationship`/`open_loop`/
// `memory`/`message`/etc. If its free-text `answer` were treated as ordinary evidence, the
// model could steer `general` into asserting something about a real person (e.g. "what do
// you know about Maya Chen") and then have THIS turn's own agent draft cite that assertion —
// grounding itself, making I2 circular and worthless. Two things stop that:
//   1. `general`'s output shape (types.ts) has no `display` field, so it can never populate
//      `names` (the ONLY thing a "name" claim is checked against — see `isNameKey` below).
//   2. `buildEvidencePool` ALSO excludes any tool call named "general" from `names` and from
//      the separate `handleRawStrings` set that handle claims are checked against — belt and
//      suspenders, so a future field rename in `general`'s shape can't silently reopen this.
// Numbers and dates from `general` DO ground ordinary claims (they populate `words`/
// `numbers`/`rawStrings` like any other tool) — a world fact ("Paris has ~2.1 million
// people") is allowed to ground its own number; a claim ABOUT A PERSON is not. See
// `test/verifier.test.ts`'s "general tool" describe block for the pinned regression.
//
// RESIDUAL RISK, disclosed rather than hidden (also logged in INTERFACES.md): `extractClaims`'s
// "name" detection (PROPER_NOUN_RE) is lexical, not semantic — it cannot tell "Maya" (a
// person) apart from "Paris" or "Eiffel" (not people). Given that, the ONLY safe rule
// available is the blunt one implemented here: `general` grounds NO "name"-kind claim,
// full stop. The cost: a general-knowledge answer that mentions any capitalized proper
// noun (a place, a brand, a historical figure) will routinely fail first-pass AND escalated
// verification and fall to `defaultDegrade`. This is NOT a fabrication or a wrong answer —
// `renderGroundedSummary`'s "general" case restates the tool's own `answer` text verbatim
// (never regenerated model prose), so the user still gets the correct fact — but it costs an
// extra escalation round-trip and shows up as `status: "degraded"` in telemetry for a large
// fraction of ordinary `general` queries. Loosening this (e.g. letting `general`'s own text
// ground its own proper nouns) was considered and rejected: it would let a query like "who
// is Maya Chen" reintroduce exactly the exploit this file's tests pin — a real person's name
// grounding an unrelated relationship claim purely because `general` said it. Precision over
// recall, per this file's stated policy at the top of the file.

import type { EvidenceRef, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Evidence pool — built ONLY from this turn's tool outputs.
// ---------------------------------------------------------------------------

export type ToolCallRecord = {
  tool: string;
  output: ToolResult<Record<string, unknown>>;
};

export type EvidencePool = {
  /** Lowercased word tokens found anywhere in a NON-IDENTIFIER tool output string value.
   * Used only for the date claim's month-name check — NOT for name claims, see `names`. */
  words: ReadonlySet<string>;
  /** Digit sequences found anywhere in a NON-IDENTIFIER tool output string or number value. */
  numbers: ReadonlySet<string>;
  /** Word tokens found ONLY in leaves reached through a name-carrying key (`display`).
   * This is the ONLY thing a "name" claim is checked against — see the BLOCKING fix note
   * on `isNameKey` below for why free prose and identifiers are both excluded from it. */
  names: ReadonlySet<string>;
  /** Lowercased, whitespace-collapsed NON-IDENTIFIER string values, for the ISO-date
   * substring check. Includes `general` tool output — a world-fact date is fine to ground
   * off model knowledge. */
  rawStrings: readonly string[];
  /** Same as `rawStrings` EXCEPT leaves produced by a tool call named "general" are
   * excluded. This is the ONLY thing a "handle" claim is checked against — see the
   * `general`-tool header note above for why: an email/phone/@mention the model itself
   * asserted via `general` must not verify a handle claim about a specific person. */
  handleRawStrings: readonly string[];
  /** Every {source,id} evidence ref returned this turn, for downstream provenance display. */
  refs: readonly EvidenceRef[];
};

type CollectedLeaves = {
  /** Prose/data leaves reached through an ordinary (non-id) key — free to ground
   * number/date claims and the date check's month words. */
  text: string[];
  /** Leaves reached through a name-carrying key (`display`) — the ONLY source a "name"
   * claim may be grounded against. A strict subset of `text` (every name leaf is also
   * pushed to `text`), not a replacement for it. */
  names: string[];
  /** Leaves reached through an `id`-shaped key (`id`, `person_id`, `loop_id`, `thread_id`,
   * ...). Opaque identifiers. Deliberately fed into NOTHING that grounds a claim — not
   * `text`, not `names`, not even `rawStrings` — see the BLOCKING/SHOULD-FIX notes below
   * for the two concrete exploits this closes. Their referential value is already tracked
   * separately via `call.output.evidence`. */
  ids: string[];
};

function isIdentifierKey(key: string | null): boolean {
  if (key === null) return false;
  const k = key.toLowerCase();
  return k === "id" || k.endsWith("_id");
}

// BLOCKING fix (second adversarial pass): a "name" claim was checked against `words`,
// which every string leaf populated — prose AND identifiers alike. Concretely:
// `openLoopCall()`'s description "...on the trip on August 8, 2026" put "trip" in `words`;
// the model writing "Trip asked about the plan again." then extracted a NAME claim "Trip"
// that verified as grounded, purely because a topic noun happened to sit in a snippet. Same
// root cause, second symptom: "loop_12" tokenized on `_` into "loop", so a fabricated
// "Loop" name claim verified off an opaque id. Person names must ground against a
// NAME-CARRYING FIELD, not "any word that appeared somewhere" — `display` is that field;
// every §4.2 tool that returns a person returns one.
//
// Accepted, deliberate tradeoff: a third party mentioned only inside a snippet or
// description ("Maya said Jordan is coming") now fails to ground "Jordan" and forces a
// regenerate. That is correct under this file's own stated policy (false positive = wasted
// regenerate, false negative = shipped fabrication) — "Jordan" appearing in message TEXT is
// not the same claim as a §4.2 tool asserting Jordan is a person in this relationship
// graph, and I2 does not get to treat prose mentions as equivalent to structured evidence
// just because both are technically "in a tool result from this turn." Do not "fix" this
// back to checking prose — that is reintroducing the exact defect this comment describes.
function isNameKey(key: string | null): boolean {
  return key !== null && key.toLowerCase() === "display";
}

/** Walks a tool output, splitting string/number leaves into `text`, `names`, or `ids` by
 * the KEY they were reached through — not by guessing from the value's shape. This is what
 * makes the split reliable: `person_id: "p_maya01"` and `age_days: 4` look nothing alike as
 * values, but the key tells you unambiguously which bucket each belongs in. */
function collectLeaves(value: unknown, key: string | null, into: CollectedLeaves): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    if (isIdentifierKey(key)) {
      into.ids.push(String(value));
      return;
    }
    into.text.push(String(value));
    if (isNameKey(key)) into.names.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, key, into);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) collectLeaves(item, childKey, into);
  }
}

const WORD_RE = /[a-z0-9']+/g;
const DIGIT_RUN_RE = /\d+/g;

/** Builds the evidence pool from exactly the tool outputs of the current turn. Callers
 * must not carry a pool across turns — a stale pool is how a prior turn's fact leaks in
 * as if it were grounded now. */
export function buildEvidencePool(calls: readonly ToolCallRecord[]): EvidencePool {
  const words = new Set<string>();
  const numbers = new Set<string>();
  const names = new Set<string>();
  const rawStrings: string[] = [];
  const handleRawStrings: string[] = [];
  const refs: EvidenceRef[] = [];

  const addWords = (raw: string, into: Set<string>): void => {
    const normalized = raw.toLowerCase().trim().replace(/\s+/g, " ");
    if (normalized === "") return;
    for (const match of normalized.matchAll(WORD_RE)) into.add(match[0]);
  };

  for (const call of calls) {
    const leaves: CollectedLeaves = { text: [], names: [], ids: [] };
    collectLeaves(call.output, null, leaves);
    // `general` (tools.ts) answers from the model's own knowledge, not a person-bearing
    // store — see this file's header note. Its leaves still populate `words`/`numbers`/
    // `rawStrings` (world-fact dates/numbers are fine to ground), but NEVER `names` and
    // NEVER `handleRawStrings` — that is the one thing standing between "general" and
    // becoming a fabrication-laundering path for a person's name or handle.
    const isGeneralSource = call.tool === "general";
    // Opaque identifiers (`leaves.ids`) intentionally contribute to NOTHING below — no
    // rawStrings, no words, no numbers. SHOULD-FIX (same pass): a handle claim like "@12"
    // used to verify off "loop_12" via a bare `rawStrings.some(s => s.includes(...))`
    // substring check, because id leaves fed rawStrings too. Excluding them here closes
    // that the same way the name fix closes its exploit: at the source, not at each
    // individual check.
    for (const s of leaves.text) {
      const normalized = s.toLowerCase().trim().replace(/\s+/g, " ");
      if (normalized === "") continue;
      rawStrings.push(normalized);
      if (!isGeneralSource) handleRawStrings.push(normalized);
      addWords(normalized, words);
      for (const match of normalized.matchAll(DIGIT_RUN_RE)) {
        numbers.add(match[0]);
        numbers.add(String(Number(match[0]))); // strips leading zeros, e.g. "08" -> "8"
      }
    }
    // Defense in depth: `general`'s own output shape has no `display` key so `leaves.names`
    // is already empty for it (see types.ts's GeneralOutput note) — this `isGeneralSource`
    // guard means that stays true even if that shape is ever carelessly extended.
    if (!isGeneralSource) {
      for (const s of leaves.names) addWords(s, names);
    }
    if (Array.isArray(call.output.evidence)) refs.push(...call.output.evidence);
  }

  return { words, numbers, names, rawStrings, handleRawStrings, refs };
}

// ---------------------------------------------------------------------------
// Claim extraction — heuristic, deliberately conservative in the safe direction.
// ---------------------------------------------------------------------------

export type ClaimKind = "name" | "handle" | "date" | "number";
export type Claim = { kind: ClaimKind; value: string };

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
];

/** Common capitalized words that are not people's names — sentence openers, pronouns,
 * assistant register. Kept intentionally short: an unlisted common word just costs a
 * spurious regenerate, which is the safe failure direction. */
const NAME_STOPWORDS = new Set([
  "i", "i'm", "i've", "i'll", "i'd", "the", "a", "an", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "your", "yours", "my", "mine", "ok", "okay", "hey",
  "yes", "no", "please", "thanks", "thank", "hi", "hello", "sorry", "here", "there",
  "today", "tomorrow", "yesterday", "as", "of", "utc",
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// NOTE (not a bug, left as-is): PHONE_RE also matches ISO dates ("2026-08-09" is 10 digits
// with separators, same as a phone number shape), so a date can get double-claimed as both
// a handle and a date. In the common case both checks resolve as supported off the same
// evidence, and over-flagging is this module's declared safe direction — so this is left
// unnarrowed rather than risking a phone-number false negative from a tighter pattern.
const PHONE_RE = /(?<!\d)\+?\d[\d\-\s().]{7,}\d(?!\d)/g;
const MENTION_RE = /@[a-z0-9_.]{2,}/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const MONTH_DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:(?:,)?\s+\d{4})?\b/gi;
// Apostrophe deliberately excluded from the character class (not just relying on \b) so a
// possessive like "Maya's" or a contraction like "Here's" extracts as the bare name/word
// "Maya" / "Here" rather than swallowing the "'s" into the token.
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z-]{1,}\b/g;
const STANDALONE_NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;

/** Extracts every candidate name/handle/date/number atom from generated text. Order of
 * extraction matters: handles and dates are pulled out first and excluded from the plain
 * name/number passes so a phone number or "Aug 8, 2026" isn't double-counted as a bare
 * number claim on top of its date/handle claim. */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  let masked = text;

  const mask = (re: RegExp, kind: ClaimKind) => {
    for (const match of text.matchAll(re)) {
      claims.push({ kind, value: match[0] });
    }
    masked = masked.replace(re, (m) => " ".repeat(m.length));
  };

  mask(EMAIL_RE, "handle");
  mask(PHONE_RE, "handle");
  mask(MENTION_RE, "handle");
  mask(ISO_DATE_RE, "date");
  mask(MONTH_DATE_RE, "date");

  for (const match of masked.matchAll(PROPER_NOUN_RE)) {
    const word = match[0];
    if (NAME_STOPWORDS.has(word.toLowerCase())) continue;
    if (MONTHS.includes(word.toLowerCase())) continue; // caught by MONTH_DATE_RE when paired with a day
    claims.push({ kind: "name", value: word });
  }

  for (const match of masked.matchAll(STANDALONE_NUMBER_RE)) {
    claims.push({ kind: "number", value: match[0] });
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerificationViolation = { claim: Claim; reason: string };

export type VerificationResult =
  | { ok: true }
  | { ok: false; violations: VerificationViolation[] };

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeMonthDate(value: string): { month: string; day: string; year: string | null } | null {
  const match = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(value.trim());
  if (match === null) return null;
  return { month: match[1]!.toLowerCase(), day: String(Number(match[2])), year: match[3] ?? null };
}

function isSupported(claim: Claim, pool: EvidencePool): boolean {
  switch (claim.kind) {
    case "name": {
      // Grounded against `names` (display-keyed leaves only), NOT `words` (every leaf) —
      // see the BLOCKING fix note on `isNameKey` in buildEvidencePool for why.
      return pool.names.has(claim.value.toLowerCase());
    }
    case "number": {
      return pool.numbers.has(claim.value) || pool.numbers.has(String(Number(claim.value)));
    }
    case "handle": {
      // `handleRawStrings` excludes `general`-tool leaves — see this file's header note and
      // the `general`-tool comment in buildEvidencePool. A handle must trace to a
      // person-bearing tool result, never to the model's own free-text "general" answer.
      const digits = digitsOf(claim.value);
      if (digits.length >= 5 && pool.handleRawStrings.some((s) => digitsOf(s).includes(digits))) return true;
      const lowered = claim.value.toLowerCase().replace(/^@/, "");
      return pool.handleRawStrings.some((s) => s.includes(lowered));
    }
    case "date": {
      if (ISO_DATE_RE.test(claim.value)) {
        ISO_DATE_RE.lastIndex = 0;
        return pool.rawStrings.some((s) => s.includes(claim.value));
      }
      const parsed = normalizeMonthDate(claim.value);
      if (parsed === null) return false;
      const monthSupported = pool.words.has(parsed.month)
        || MONTHS.some((m) => pool.words.has(m) && m.startsWith(parsed.month));
      const daySupported = pool.numbers.has(parsed.day);
      const yearSupported = parsed.year === null || pool.numbers.has(parsed.year);
      return monthSupported && daySupported && yearSupported;
    }
    default:
      return false;
  }
}

/** The gate itself: every extracted claim must be supported by this turn's evidence pool. */
export function verify(text: string, pool: EvidencePool): VerificationResult {
  const claims = extractClaims(text);
  const violations: VerificationViolation[] = [];
  for (const claim of claims) {
    if (!isSupported(claim, pool)) {
      violations.push({ claim, reason: `unsupported_${claim.kind}` });
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// Regenerate-once-then-degrade (I1, I2)
// ---------------------------------------------------------------------------

export type VerifiedTurnOutcome =
  | { status: "verified"; text: string; attempt: "first" | "regenerated" }
  | { status: "degraded"; text: string; violations: VerificationViolation[] };

export type RegenerateFn = (violationSummary: string) => Promise<string>;
/** Degrade renders from the TURN'S TOOL CALLS, not the flattened pool — it needs the
 * structured `display` / `description` / `snippet` fields to write human prose, which the
 * pool's word/number sets throw away on purpose. */
export type DegradeFn = (calls: readonly ToolCallRecord[]) => string;

function summarizeViolations(violations: VerificationViolation[]): string {
  const named = violations
    .map((v) => `${v.reason}: "${v.claim.value}"`)
    .join("; ");
  return `The previous answer stated the following without support from this turn's tool results: ${named}. Revise the answer so every person name, handle, date, and number you state is drawn only from the tool results already returned this turn. If you cannot support a claim, omit it.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Renders one plain-language sentence per tool call using only its own human-facing
 * fields (display names, descriptions, snippets, memory text) — never `person_id`,
 * `loop_id`, `memory_id`, or any other internal hashed identifier. This is what §2's
 * "degrade to a grounded summary" means: prose a user could read, not a provenance dump.
 * Unrecognized/empty tool shapes are silently skipped rather than guessed at.
 */
function renderGroundedSummary(calls: readonly ToolCallRecord[]): string {
  const sentences: string[] = [];

  for (const call of calls) {
    const out = call.output;
    switch (call.tool) {
      case "relationship_state": {
        const display = asString(out["display"]);
        const stage = asString(out["lifecycle_stage"]);
        if (display !== null) sentences.push(stage !== null ? `${display}: ${stage}.` : `${display}: no stage on record.`);
        break;
      }
      case "open_loops": {
        for (const row of asArray(out["loops"])) {
          if (!isRecord(row)) continue;
          const display = asString(row["display"]);
          const description = asString(row["description"]);
          if (display !== null && description !== null) sentences.push(`${display}: ${description}.`);
        }
        break;
      }
      case "drifting": {
        for (const row of asArray(out["relationships"])) {
          if (!isRecord(row)) continue;
          const display = asString(row["display"]);
          const overdue = row["overdue_by_days"];
          if (display !== null && typeof overdue === "number") sentences.push(`${display} is overdue by ${overdue} days.`);
        }
        break;
      }
      case "circle": {
        for (const row of asArray(out["connections"])) {
          if (!isRecord(row)) continue;
          const display = asString(row["display"]);
          if (display !== null) sentences.push(`${display} is in the circle.`);
        }
        break;
      }
      case "search_messages": {
        for (const row of asArray(out["results"])) {
          if (!isRecord(row)) continue;
          const display = asString(row["display"]);
          const snippet = asString(row["snippet"]);
          if (display !== null && snippet !== null) sentences.push(`${display}: "${snippet}".`);
        }
        break;
      }
      case "memory_search": {
        for (const row of asArray(out["memories"])) {
          if (!isRecord(row)) continue;
          const text = asString(row["text"]);
          if (text !== null) sentences.push(text.endsWith(".") ? text : `${text}.`);
        }
        break;
      }
      case "draft_message": {
        const draft = asString(out["draft"]);
        if (draft !== null) sentences.push(draft.endsWith(".") ? draft : `${draft}.`);
        break;
      }
      case "general": {
        // Restated here exactly as tools.ts's `general` returned it — this is the tool's
        // own text, not free model prose generated fresh for this bubble, so it carries no
        // I2 risk. It is still never used to ground a NAME/HANDLE claim about a person (see
        // this file's header note) — that restriction lives in buildEvidencePool/isSupported,
        // not here; this branch only decides what the degrade summary reads like.
        const answer = asString(out["answer"]);
        if (answer !== null) sentences.push(answer.endsWith(".") ? answer : `${answer}.`);
        break;
      }
      default:
        break; // memory_write / send_message / unrecognized tools: nothing to restate.
    }
  }

  return sentences.join(" ");
}

// Task 2 ("refusals must offer a way forward"): a decline that dead-ends is a worse outcome
// than a decline that redirects to something the product can actually do. This lists real
// tool names/capabilities only — never a specific person (a person can only be named if
// they came from THIS turn's grounded evidence, which by definition this branch doesn't
// have, since there was nothing groundable to report). See `hasUsefulAlternative` below and
// its pinned tests for what "useful alternative" means as a checkable property, not just a
// vibe.
const CAPABILITY_HINT =
  "I can look up someone's relationship status, search your messages, check open loops, see who's overdue, or answer a general-knowledge question — want to try one of those?";

/** Default degrade: a plain, evidence-only summary built from this turn's tool calls —
 * never free model text — so a repeated fabrication still degrades to something true
 * rather than to silence, and never surfaces internal hashed IDs to the user. When there is
 * nothing groundable to restate, the decline still redirects to real capabilities rather
 * than dead-ending (Task 2) — it never invents a capability or names an ungrounded person. */
/**
 * A pure general-knowledge turn degrades for a reason that is NOT a fabrication risk, and it
 * must not be dressed up as one.
 *
 * `extractClaims` flags any capitalized word as a name-kind claim, and `general` deliberately
 * grounds zero name claims (see the I2 note above) — so "New York in August" trips the gate on
 * two ordinary proper nouns and the whole answer falls to degrade. The information is fine; the
 * apology in front of it is what makes a correct answer read as a malfunction.
 *
 * This returns `general`'s own text verbatim when EVERY tool call this turn was `general`. That
 * is the same text the generic degrade path would have quoted, minus the misleading preamble.
 *
 * Safety: this is gated on there being NO person-scoped tool call in the turn. If any
 * relationship/loop/memory tool ran, this path does not apply and the strict degrade stands, so
 * a general answer can still never launder a claim about a real person in the user's life.
 */
function generalOnlyAnswer(calls: readonly ToolCallRecord[]): string | null {
  if (calls.length === 0) return null;
  if (!calls.every((c) => c.tool === "general")) return null;
  const texts: string[] = [];
  for (const c of calls) {
    const answer = (c.output as Record<string, unknown>)["answer"];
    if (typeof answer === "string" && answer.trim() !== "") texts.push(answer.trim());
  }
  return texts.length > 0 ? texts.join(" ") : null;
}

export function defaultDegrade(calls: readonly ToolCallRecord[]): string {
  const generalOnly = generalOnlyAnswer(calls);
  if (generalOnly !== null) return generalOnly;
  const summary = renderGroundedSummary(calls);
  if (summary === "") {
    return `I couldn't verify an answer to that from anything I looked up this turn. ${CAPABILITY_HINT}`;
  }
  return `I couldn't confidently phrase that without adding unsupported details. Here's what I actually found: ${summary}`;
}

/**
 * Task 2's release-gate check: a refusal/degrade string counts as "useful" only if it names
 * at least one real, current capability (drawn from the fixed list below, which mirrors the
 * tool names actually registered in tools.ts) rather than just declining. Used by the eval
 * corpus (eval-cases.ts's REFUSAL_EVAL_CASES / eval.ts's runRefusalEval) so a regression back
 * to a bare "I can't answer that" dead end fails a test instead of shipping silently.
 */
const CAPABILITY_KEYWORDS = [
  "relationship status",
  "search your messages",
  "open loops",
  "who's overdue",
  "overdue",
  "general-knowledge",
  "here's what i actually found",
  "here's what i found",
] as const;

export function hasUsefulAlternative(text: string): boolean {
  const lowered = text.toLowerCase();
  return CAPABILITY_KEYWORDS.some((kw) => lowered.includes(kw));
}

/**
 * I1's enforcement point: given the first draft, this turn's tool calls, and a way to ask
 * the model to regenerate, apply the verifier and — on the ONE permitted retry — apply it
 * again before falling back to a grounded summary. There is no third attempt and no path
 * that returns unverified text. The evidence pool is built here, from `calls`, so callers
 * cannot accidentally pass a pool built from a different (e.g. prior) turn.
 */
export async function runVerifiedTurn(
  firstDraft: string,
  calls: readonly ToolCallRecord[],
  regenerate: RegenerateFn,
  degrade: DegradeFn = defaultDegrade,
): Promise<VerifiedTurnOutcome> {
  const pool = buildEvidencePool(calls);
  const first = verify(firstDraft, pool);
  if (first.ok) return { status: "verified", text: firstDraft, attempt: "first" };

  let secondDraft: string;
  try {
    secondDraft = await regenerate(summarizeViolations(first.violations));
  } catch {
    return { status: "degraded", text: degrade(calls), violations: first.violations };
  }

  const second = verify(secondDraft, pool);
  if (second.ok) return { status: "verified", text: secondDraft, attempt: "regenerated" };

  return { status: "degraded", text: degrade(calls), violations: second.violations };
}
