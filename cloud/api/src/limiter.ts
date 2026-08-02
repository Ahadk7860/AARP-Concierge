// A fixed-window rate limiter, for the one endpoint that needs one most.
//
// `POST /v1/pair` is unauthenticated, takes six digits, and returns a `device_token`
// AND the `user_salt`. There are a million codes and a ten-minute window, so an
// unthrottled attacker gets a live one in minutes — and a `user_salt` is the key to
// every `contact_id` that account will ever compute, issued once and never rotated.
//
// In-memory and per-process. That is honest rather than ideal: behind two instances an
// attacker gets two windows. It is the right shape for one dev process and the wrong
// shape for production, where this belongs in Redis or at the edge — recorded in
// NOTES.md rather than pretended away.

export type LimiterOptions = { limit: number; windowSeconds: number };

export type LimitDecision = { allowed: boolean; remaining: number; retry_after_seconds: number };

type Window = { count: number; resetAt: number };

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly options: LimiterOptions) {}

  /**
   * Count one attempt against `key`.
   *
   * The clock is a parameter, like everywhere else in this track: a limiter tested by
   * sleeping is a limiter tested for one window or not at all.
   */
  check(key: string, now: Date = new Date()): LimitDecision {
    const at = now.getTime();
    const existing = this.windows.get(key);

    if (existing === undefined || at >= existing.resetAt) {
      const resetAt = at + this.options.windowSeconds * 1000;
      this.windows.set(key, { count: 1, resetAt });
      this.sweep(at);
      return {
        allowed: true,
        remaining: this.options.limit - 1,
        retry_after_seconds: Math.ceil(this.options.windowSeconds),
      };
    }

    existing.count += 1;
    const remaining = Math.max(0, this.options.limit - existing.count);
    return {
      allowed: existing.count <= this.options.limit,
      remaining,
      retry_after_seconds: Math.max(1, Math.ceil((existing.resetAt - at) / 1000)),
    };
  }

  /** Drop expired windows so a spray of distinct keys cannot grow the map forever. */
  private sweep(at: number): void {
    if (this.windows.size < 1024) return;
    for (const [key, window] of this.windows) {
      if (at >= window.resetAt) this.windows.delete(key);
    }
  }

  reset(): void {
    this.windows.clear();
  }
}

/**
 * Ten attempts per minute per source.
 *
 * Generous for a person typing a code off a text and mistyping it twice; useless for
 * enumerating a million of them.
 */
export const PAIR_LIMIT: LimiterOptions = { limit: 10, windowSeconds: 60 };
