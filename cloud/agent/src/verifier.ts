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

function collectLeaves(value: unknown, into: { strings: string[] }): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    into.strings.push(value);
    return;
  }
  if (typeof value === "number") {
    into.strings.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, into);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectLeaves(item, into);
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

  for (const call of calls) {
    const leaves: { strings: string[] } = { strings: [] };
    // The `evidence` field itself is refs (source ids), not narrative fact text, but its
    // ids can legitimately be quoted (e.g. a loop_id in provenance) — include everything.
    collectLeaves(call.output, leaves);
    for (const s of leaves.strings) {
      const normalized = s.toLowerCase().trim().replace(/\s+/g, " ");
      if (normalized === "") continue;
      rawStrings.push(normalized);
      for (const match of normalized.matchAll(WORD_RE)) words.add(match[0]);
      for (const match of normalized.matchAll(DIGIT_RUN_RE)) {
        numbers.add(match[0]);
        numbers.add(String(Number(match[0]))); // strips leading zeros, e.g. "08" -> "8"
      }
    }
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
export type DegradeFn = (pool: EvidencePool) => string;

function summarizeViolations(violations: VerificationViolation[]): string {
  const named = violations
    .map((v) => `${v.reason}: "${v.claim.value}"`)
    .join("; ");
  return `The previous answer stated the following without support from this turn's tool results: ${named}. Revise the answer so every person name, handle, date, and number you state is drawn only from the tool results already returned this turn. If you cannot support a claim, omit it.`;
}

/** Default degrade: a plain, evidence-only listing of what tools actually returned this
 * turn — never free model text — so a repeated fabrication still degrades to something
 * true rather than to silence. */
export function defaultDegrade(pool: EvidencePool): string {
  if (pool.refs.length === 0) {
    return "I couldn't verify an answer to that from anything I looked up this turn.";
  }
  const items = pool.refs.map((ref) => `${ref.source}:${ref.id}`).join(", ");
  return `I couldn't confidently phrase that without adding unsupported details. Here's what I found this turn: ${items}.`;
}

/**
 * I1's enforcement point: given the first draft, the evidence pool for this turn, and a
 * way to ask the model to regenerate, apply the verifier and — on the ONE permitted retry —
 * apply it again before falling back to a grounded, evidence-only summary. There is no
 * third attempt and no path that returns unverified text.
 */
export async function runVerifiedTurn(
  firstDraft: string,
  pool: EvidencePool,
  regenerate: RegenerateFn,
  degrade: DegradeFn = defaultDegrade,
): Promise<VerifiedTurnOutcome> {
  const first = verify(firstDraft, pool);
  if (first.ok) return { status: "verified", text: firstDraft, attempt: "first" };

  let secondDraft: string;
  try {
    secondDraft = await regenerate(summarizeViolations(first.violations));
  } catch {
    return { status: "degraded", text: degrade(pool), violations: first.violations };
  }

  const second = verify(secondDraft, pool);
  if (second.ok) return { status: "verified", text: secondDraft, attempt: "regenerated" };

  return { status: "degraded", text: degrade(pool), violations: second.violations };
}
