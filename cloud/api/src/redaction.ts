// THE SECOND OF THE THREE is_from_me GUARDS. CONTRACTS.md § 7.
//
// The Mac holds the first (the SQL query, `is_from_me = 1`) and
// `scripts/check_voice_pack_leak.py` holds the third. Per § 7's "What guard three does
// and does not do", the third is a verbatim string check that weakens exactly as
// redaction gets more aggressive — a regression alarm, not a proof. This guard runs in
// production on data this track did not generate, which makes it the one that catches a
// regression in somebody else's code after that code has shipped.
//
// EVERY FREE-TEXT FIELD, NOT JUST `exemplars`.
//
// This guard originally scanned `pack.exemplars` and nothing else, while the repository
// persisted `JSON.stringify(pack)` — the whole document. `register.apology_openers`
// holds VERBATIM MESSAGE PREFIXES (the committed fixture's are "sorry been mia" and
// "omg sorry"), so a pack with spotless exemplars could carry a phone number straight
// into storage through that array, and every phone/email/amount test stayed green
// because none of them looked there. § 7 now names the requirement outright: a guard
// that inspects one of four free-text fields is not the guard § 7 claims it is.
//
// The fields are enumerated from the pack itself below rather than passed in, so a
// caller cannot scan a subset by accident.
//
// A pack that fails here is rejected with `422 redaction_failed` and stored NOWHERE.
// This is a frozen anchor. Do not weaken a pattern to make a checklist green.

import type { VoicePack, VoicePackV2 } from "../../shared/src/index.js";

export type RedactedField = "exemplars" | "apology_openers" | "abbreviations" | "top_emoji";

export type RedactionViolation = {
  /** Which assertion failed. Never carries the offending text. */
  pattern: "phone" | "email" | "street_address" | "amount";
  /** Which free-text array it was in. */
  field: RedactedField;
  /** Index within that array, so an operator can ask the Mac what went wrong. */
  index: number;
};

/**
 * Deliberately broad. A false positive costs one rejected upload, which the Mac
 * retries after redacting properly; a false negative costs a permanent, silent
 * privacy failure. The asymmetry is not close, so every pattern errs toward rejecting.
 *
 * None of them require a capital letter. § 7: "Name redaction must not assume
 * capitalization — the target corpus is lowercase texting." The same trap applies to
 * street names, and `30 usd` is as real as `$30`.
 */
const PATTERNS: ReadonlyArray<{ pattern: RedactionViolation["pattern"]; re: RegExp }> = [
  {
    // +1 (415) 555-0142, 415-555-0142, 4155550142, 555.0142 — 7+ digits with the
    // usual separators. Deliberately looser than E.164.
    pattern: "phone",
    re: /(?:\+?\d[\d().\- ]{5,}\d)/,
  },
  {
    pattern: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  },
  {
    // A number followed by a street-type word. Case-insensitive on purpose: the corpus
    // is lowercase texting, so "10 downing st" must fire exactly like "10 Downing St".
    pattern: "street_address",
    re: /\b\d+\s+(?:[A-Za-z.'-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|terrace|place|pl|circle|cir|highway|hwy)\b\.?/i,
  },
  {
    // $40, $1,200.50, 40 dollars, 40 usd.
    pattern: "amount",
    re: /(?:[$£€]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*(?:\.\d{2})?\s?(?:dollars?|usd|eur|gbp)\b)/i,
  },
];

/**
 * Every free-text array in a pack, paired with its field name.
 *
 * `top_emoji` is included because § 7 calls it a free string too. It is the least
 * likely to carry anything, and scanning it costs nothing — the point of enumerating
 * here is that adding a free-text field to `voice_pack.v1` and forgetting to scan it
 * requires editing this function, not merely failing to.
 */
export function freeTextFields(pack: VoicePack | VoicePackV2): Array<{ field: RedactedField; values: readonly string[] }> {
  return [
    {
      field: "exemplars",
      values: pack.exemplars.map((exemplar) =>
        typeof exemplar === "string" ? exemplar : exemplar.text,
      ),
    },
    { field: "apology_openers", values: pack.register?.apology_openers ?? [] },
    { field: "abbreviations", values: pack.register?.abbreviations ?? [] },
    { field: "top_emoji", values: pack.register?.top_emoji ?? [] },
  ];
}

/**
 * Every violation anywhere in the pack, not just the first, and not just in
 * `exemplars`. Returning all of them means one rejection tells the Mac everything it
 * has to fix rather than sending it round the loop once per bad string.
 */
export function findRedactionViolations(pack: VoicePack | VoicePackV2): RedactionViolation[] {
  const violations: RedactionViolation[] = [];
  for (const { field, values } of freeTextFields(pack)) {
    values.forEach((value, index) => {
      for (const { pattern, re } of PATTERNS) {
        if (re.test(value)) violations.push({ pattern, field, index });
      }
    });
  }
  return violations;
}

/** Scan a bare array. Used by the per-pattern tests; the route uses the pack form. */
export function findViolationsInStrings(
  values: readonly string[],
): Array<RedactionViolation["pattern"]> {
  const out: Array<RedactionViolation["pattern"]> = [];
  for (const value of values) {
    for (const { pattern, re } of PATTERNS) if (re.test(value)) out.push(pattern);
  }
  return out;
}

/**
 * A `detail` string safe to put in an HTTP response and a log line.
 *
 * Names the pattern, the field and the index — never the text. Echoing the offending
 * string back would hand unredacted content straight to whatever aggregates the logs,
 * which is the failure this guard exists to prevent.
 */
export function describeViolations(violations: readonly RedactionViolation[]): string {
  const grouped = new Map<string, number[]>();
  for (const v of violations) {
    const key = `${v.pattern} in ${v.field}`;
    const list = grouped.get(key) ?? [];
    list.push(v.index);
    grouped.set(key, list);
  }
  return [...grouped.entries()]
    .map(([key, idx]) => `${key} at ${idx.join(", ")}`)
    .join("; ");
}

/**
 * NOT ASSERTED HERE: third-party full names.
 *
 * § 7 lists them alongside the four patterns above, and this guard does not check them.
 * § 7's own "Name redaction must not assume capitalization" is why: the only cheap
 * server-side test is two consecutive capitalised words, which § 7 says would miss
 * `"ill ask john smith about it"` in a lowercase-texting corpus — and would
 * simultaneously reject "Union Square", "Blue Bottle" and "New Year", legitimate
 * exemplars with no edit the Mac can make to comply. It is wrong in both directions at
 * once.
 *
 * Detecting a name needs a name list, and the Mac has one — it has the address book.
 * Guard one covers this and guard two cannot. Recorded in NOTES.md under
 * `## Decisions made`; overrule it there if you would rather have the heuristic.
 */
export const NAMES_ARE_NOT_ASSERTED_HERE = true;
