// When the brief fires: roughly 8am, in each user's own morning.
//
// 8am UTC is 1am in Los Angeles and 4pm in Sydney. A "morning brief" that arrives at
// either is not a morning brief, and the habit the whole product depends on is a
// morning habit. So the schedule is per-user, computed from `users.timezone`.
//
// The clock is a parameter everywhere. A scheduler tested by sleeping is a scheduler
// tested once, badly, and this one has to be correct across a DST boundary it will only
// see twice a year.

export const SEND_HOUR_LOCAL = 8;
/** How close to 8am local counts as on time. The Definition of Done asks for 15. */
export const WINDOW_MINUTES = 15;

export type UserSchedule = { user_id: string; timezone: string };

/**
 * The local wall-clock time at `instant`, in `timezone`.
 *
 * `Intl` rather than arithmetic on an offset: offsets change twice a year, and the
 * whole point of storing an IANA zone rather than a number is to let the library carry
 * that. Hand-rolled `utcOffset` is the bug that fires at 2am on one Sunday in March.
 */
export function localParts(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** `YYYY-MM-DD` in the user's zone. The idempotency key for "one brief per day". */
export function localDayKey(instant: Date, timezone: string): string {
  const { year, month, day } = localParts(instant, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Is `now` inside this user's send window?
 *
 * A window rather than an instant, because a scheduler tick is not infinitely precise
 * and a brief that misses 08:00:00 by ninety seconds should still go out.
 */
export function isDue(now: Date, timezone: string): boolean {
  const { hour, minute } = localParts(now, timezone);
  if (hour !== SEND_HOUR_LOCAL) return false;
  return minute < WINDOW_MINUTES;
}

/**
 * The canonical instant this user's brief is FOR.
 *
 * Not `now`. Two ticks four minutes apart inside the same window must produce the same
 * `scheduled_for`, or `briefs`' `unique (user_id, scheduled_for)` cannot tell a retry
 * from a second brief — and the user gets two briefs on one morning.
 *
 * Derived by searching the hour around `now` for the instant whose local time is
 * exactly 08:00. Searching rather than computing, because an offset arithmetic shortcut
 * is wrong on precisely the days it matters.
 */
export function slotFor(now: Date, timezone: string): Date {
  const { year, month, day } = localParts(now, timezone);
  // Start from 08:00 UTC on the same local date and walk the offset out. A day is 1440
  // minutes; stepping 15 covers every real zone offset including the :30 and :45 ones.
  const base = Date.UTC(year, month - 1, day, SEND_HOUR_LOCAL, 0, 0, 0);
  for (let shift = -14 * 60; shift <= 14 * 60; shift += 15) {
    const candidate = new Date(base + shift * 60_000);
    const local = localParts(candidate, timezone);
    if (
      local.year === year &&
      local.month === month &&
      local.day === day &&
      local.hour === SEND_HOUR_LOCAL &&
      local.minute === 0
    ) {
      return candidate;
    }
  }
  // A zone with no 08:00 on this date (a DST jump straight over it). Fall back to the
  // start of the window we are already in, which is the honest answer: we are sending
  // now because now is this user's morning.
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/** Everyone whose morning it is right now. */
export function dueUsers(now: Date, users: readonly UserSchedule[]): UserSchedule[] {
  return users.filter((u) => isDue(now, u.timezone));
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export const MAX_SEND_ATTEMPTS = 3;
/** Backoff in seconds. Bounded and explicit — never a loop, never unbounded. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 900];

export type RetrySchedule = { attempt: number; next_attempt_at: string | null; exhausted: boolean };

/**
 * What to do after a failed send.
 *
 * Returns a TIME, never a sleep. "Retried on a schedule, not in a loop" is the whole
 * requirement: a tight retry against a banned line is how one failure becomes a
 * thousand requests and a line-level ban becomes permanent.
 */
export function nextRetry(attempt: number, now: Date): RetrySchedule {
  if (attempt >= MAX_SEND_ATTEMPTS) {
    return { attempt, next_attempt_at: null, exhausted: true };
  }
  const backoff = RETRY_BACKOFF_SECONDS[attempt] ?? RETRY_BACKOFF_SECONDS.at(-1) ?? 900;
  return {
    attempt: attempt + 1,
    next_attempt_at: new Date(now.getTime() + backoff * 1000).toISOString(),
    exhausted: false,
  };
}
