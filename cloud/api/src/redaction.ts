// THE SECOND OF THE THREE is_from_me GUARDS. CONTRACTS.md § 7.
//
// The Mac holds the first (the SQL query, `is_from_me = 1`) and
// `scripts/check_voice_pack_leak.py` holds the third (a check that fails the build).
// This one is different from both: it runs in production, on data this track did not
// generate, so it is the only one of the three that catches a regression in somebody
// else's code after that code has shipped.
//
// A pack that fails here is rejected with `422 redaction_failed` and **stored
// nowhere**. Not stored-and-flagged, not stored-in-quarantine — the route never
// reaches the repository. One inbound message riding along in an exemplar list makes
// every privacy claim in the architecture false, and nobody would notice for months.
//
// This is a frozen anchor. Do not weaken a pattern to make a checklist green.

export type RedactionViolation = {
  /** Which assertion failed. Never carries the offending text. */
  pattern: "phone" | "email" | "street_address" | "amount";
  /** Index into `exemplars`, so an operator can ask the Mac what went wrong. */
  exemplar_index: number;
};

/**
 * Deliberately broad. A false positive costs one rejected upload, which the Mac
 * retries after redacting properly; a false negative costs a permanent, silent
 * privacy failure. The asymmetry is not close, so every pattern below errs toward
 * rejecting.
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
    // A number followed by a street-type word. "742 Evergreen Terrace", "10 Downing St".
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
 * Every violation in the pack, not just the first.
 *
 * Returning all of them means one rejection tells the Mac everything it has to fix,
 * rather than sending it round the loop once per bad exemplar.
 */
export function findRedactionViolations(exemplars: readonly string[]): RedactionViolation[] {
  const violations: RedactionViolation[] = [];
  exemplars.forEach((exemplar, exemplar_index) => {
    for (const { pattern, re } of PATTERNS) {
      if (re.test(exemplar)) violations.push({ pattern, exemplar_index });
    }
  });
  return violations;
}

/**
 * A `detail` string safe to put in an HTTP response and a log line.
 *
 * Names the pattern and the index, never the text. The whole point of the guard is
 * that unredacted content must not escape; echoing it back in the error message would
 * hand it straight to whatever aggregates the logs.
 */
export function describeViolations(violations: readonly RedactionViolation[]): string {
  const byPattern = new Map<string, number[]>();
  for (const v of violations) {
    const list = byPattern.get(v.pattern) ?? [];
    list.push(v.exemplar_index);
    byPattern.set(v.pattern, list);
  }
  return [...byPattern.entries()]
    .map(([pattern, idx]) => `${pattern} at exemplar ${idx.join(", ")}`)
    .join("; ");
}

/**
 * NOT ASSERTED HERE: third-party full names.
 *
 * CONTRACTS.md § 7 lists them alongside the four patterns above, and this guard does
 * not check them. A server-side full-name assertion means "two consecutive capitalised
 * words", which rejects "Union Square", "Blue Bottle" and "New Year" — legitimate
 * exemplars, rejected permanently, with no way for the Mac to comply. Over-rejection
 * looks safe and is not: a user whose packs are always rejected gets no drafts at all,
 * and "degrade, never fabricate" does not mean "degrade to nothing".
 *
 * Names need a name list to detect, and the Mac has one (it has the address book).
 * Guards one and three cover this; guard two does not. Recorded in NOTES.md.
 */
export const NAMES_ARE_NOT_ASSERTED_HERE = true;
