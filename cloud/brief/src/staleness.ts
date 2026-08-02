// Staleness, which is the second of the three properties everything depends on.
//
// CONTRACTS.md § 0: "The Mac is allowed to be asleep. Staleness is a VISIBLE STATE,
// never a silent wrong answer." A brief composed from four-day-old facts is not wrong
// because the facts changed; it is wrong because it presents them as this morning's.
// Saying "Haven't seen your Mac since Tuesday, so this is as of then" costs one line
// and converts a lie into a caveat.
//
// Past a hard threshold there is no honest caveat left, and the send is skipped. A
// week-old brief telling you to reply to someone you spoke to yesterday is worse than
// no brief: it is the "confidently wrong about a person's friend" failure § 6 names.

export const DEFAULT_WARN_HOURS = 24;
/**
 * Beyond this, skip.
 *
 * `.env.example` had `BOI_STALENESS_WARN_HOURS` and no skip threshold — appended as
 * `BOI_STALENESS_SKIP_HOURS`, recorded in NOTES.md. 168 hours is a week: it sits above
 * the 98-hour case the Definition of Done requires to still WARN rather than skip, and
 * a Mac asleep a full week is a different situation from one asleep over a weekend.
 */
export const DEFAULT_SKIP_HOURS = 168;

export function warnHours(): number {
  return Number(process.env["BOI_STALENESS_WARN_HOURS"] ?? DEFAULT_WARN_HOURS);
}

export function skipHours(): number {
  return Number(process.env["BOI_STALENESS_SKIP_HOURS"] ?? DEFAULT_SKIP_HOURS);
}

export type Staleness = {
  digest_as_of: string;
  hours_stale: number;
  warn: boolean;
  message: string | null;
};

/** Rounded to one decimal, matching `contracts/fixtures/brief/stale_warning.json`. */
export function hoursBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10;
}

/**
 * The day name, in the USER's timezone.
 *
 * A brief that says "since Tuesday" has to mean Tuesday where the user is standing.
 * `users.timezone` exists for exactly this; UTC would put anyone west of Greenwich a
 * day out for part of every evening.
 */
export function dayName(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(at);
}

/**
 * The caveat, in the user's own terms.
 *
 * Deliberately about the Mac, not about the user. "Haven't seen your Mac since Tuesday"
 * is a fact about our own visibility; "you haven't opened your laptop since Tuesday"
 * would be a small accusation, and § 6's invitation-never-verdict rule does not stop
 * applying because the sentence is about a machine the user owns.
 */
export function stalenessMessage(digestAsOf: Date, timezone: string): string {
  return `Haven't seen your Mac since ${dayName(digestAsOf, timezone)}, so this is as of then.`;
}

export type StalenessDecision = {
  staleness: Staleness;
  /** True when the brief must NOT be sent at all. */
  skip: boolean;
  skip_reason: "digest_too_stale" | null;
};

export function assessStaleness(input: {
  digest_as_of: Date;
  now: Date;
  timezone: string;
}): StalenessDecision {
  const hours = Math.max(0, hoursBetween(input.digest_as_of, input.now));
  const warn = hours > warnHours();
  const skip = hours > skipHours();

  return {
    staleness: {
      digest_as_of: input.digest_as_of.toISOString(),
      hours_stale: hours,
      warn,
      // The message exists only when there is something to warn about. A caveat on a
      // three-hour-old digest trains people to ignore caveats.
      message: warn ? stalenessMessage(input.digest_as_of, input.timezone) : null,
    },
    skip,
    skip_reason: skip ? "digest_too_stale" : null,
  };
}
