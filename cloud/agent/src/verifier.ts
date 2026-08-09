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

import type { EvidenceRef, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Evidence pool — built ONLY from this turn's tool outputs.
// ---------------------------------------------------------------------------

export type ToolCallRecord = {
  tool: string;
  output: ToolResult<Record<string, unknown>>;
};

export type EvidencePool = {
  /** Lowercased word tokens found anywhere in a tool output's string values. */
  words: ReadonlySet<string>;
  /** Digit sequences found anywhere in a tool output's string or number values. */
  numbers: ReadonlySet<string>;
  /** Lowercased, whitespace-collapsed full string values, for substring/handle checks. */
  rawStrings: readonly string[];
  /** Every {source,id} evidence ref returned this turn, for downstream provenance display. */
  refs: readonly EvidenceRef[];
};

type CollectedLeaves = {
  /** Prose/data leaves — free to ground name/number/date claims. */
  text: string[];
  /** Leaves reached through an `id`-shaped key (`id`, `person_id`, `loop_id`, `thread_id`,
   * ...). Opaque identifiers: legitimately quotable verbatim (rawStrings, for handle
   * substring checks and possible literal echoing), but MUST NOT contribute to `numbers` —
   * see the comment on `numbers` below for why. */
  ids: string[];
};

function isIdentifierKey(key: string | null): boolean {
  if (key === null) return false;
  const k = key.toLowerCase();
  return k === "id" || k.endsWith("_id");
}

/** Walks a tool output, splitting string/number leaves into `text` or `ids` by the KEY they
 * were reached through — not by guessing from the value's shape. This is what makes the
 * split reliable: `person_id: "p_maya01"` and `age_days: 4` look nothing alike as values,
 * but the key tells you unambiguously which bucket each belongs in. */
function collectLeaves(value: unknown, key: string | null, into: CollectedLeaves): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    (isIdentifierKey(key) ? into.ids : into.text).push(String(value));
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
  const rawStrings: string[] = [];
  const refs: EvidenceRef[] = [];

  const addNormalized = (raw: string, target: "text" | "id"): void => {
    const normalized = raw.toLowerCase().trim().replace(/\s+/g, " ");
    if (normalized === "") return;
    rawStrings.push(normalized);
    for (const match of normalized.matchAll(WORD_RE)) words.add(match[0]);
    if (target === "id") return; // Opaque identifiers never ground a NUMBER claim (BLOCKING
    // fix: a person_id like "p_8f3a12" or a loop_id like "loop_12" must not "ground" a bare
    // claim of "12" — DIGIT_RUN_RE would otherwise treat every digit run inside a hash or
    // suffix as a legitimate stated number, and small integers are near-universally
    // "supported" once a handful of ids are in evidence. Restrict number extraction to
    // leaves reached through a non-id key.
    for (const match of normalized.matchAll(DIGIT_RUN_RE)) {
      numbers.add(match[0]);
      numbers.add(String(Number(match[0]))); // strips leading zeros, e.g. "08" -> "8"
    }
  };

  for (const call of calls) {
    const leaves: CollectedLeaves = { text: [], ids: [] };
    collectLeaves(call.output, null, leaves);
    for (const s of leaves.text) addNormalized(s, "text");
    for (const s of leaves.ids) addNormalized(s, "id");
    if (Array.isArray(call.output.evidence)) refs.push(...call.output.evidence);
  }

  return { words, numbers, rawStrings, refs };
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
      return pool.words.has(claim.value.toLowerCase());
    }
    case "number": {
      return pool.numbers.has(claim.value) || pool.numbers.has(String(Number(claim.value)));
    }
    case "handle": {
      const digits = digitsOf(claim.value);
      if (digits.length >= 5 && pool.rawStrings.some((s) => digitsOf(s).includes(digits))) return true;
      const lowered = claim.value.toLowerCase().replace(/^@/, "");
      return pool.rawStrings.some((s) => s.includes(lowered));
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
      default:
        break; // memory_write / send_message / unrecognized tools: nothing to restate.
    }
  }

  return sentences.join(" ");
}

/** Default degrade: a plain, evidence-only summary built from this turn's tool calls —
 * never free model text — so a repeated fabrication still degrades to something true
 * rather than to silence, and never surfaces internal hashed IDs to the user. */
export function defaultDegrade(calls: readonly ToolCallRecord[]): string {
  const summary = renderGroundedSummary(calls);
  if (summary === "") {
    return "I couldn't verify an answer to that from anything I looked up this turn.";
  }
  return `I couldn't confidently phrase that without adding unsupported details. Here's what I actually found: ${summary}`;
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
