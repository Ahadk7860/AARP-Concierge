// A configurable send limiter.
//
// CONTRACTS.md section 11 item 3: the real limits are unknown and are a sales-call
// answer, not a research answer. So the numbers live in config and the default is
// deliberately conservative. When the answer arrives it is a `.env` change, not a code
// change — which is the whole point of putting it here rather than inlining a constant
// at the call site.
//
// Boi's load is roughly the inverse of the ban signature anyway: one brief per user per
// day, to a consenting recipient, high recipient diversity, near-balanced send-to-
// receive. Our exposure is not our volume. The limiter exists because we are a tenant on
// somebody else's shared identity and cannot see the other tenants' behaviour.
//
// Provider-neutral by construction: nothing here knows who is being called.

export type LimitBehaviour = "delay" | "reject";

export type RateLimiterOptions = {
  /** Maximum permits granted per `intervalMs`. */
  maxPerInterval: number;
  intervalMs: number;
  /** `delay` waits for the next permit; `reject` throws immediately. */
  behaviour: LimitBehaviour;
  /** Injectable so tests are deterministic rather than timing-dependent. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RateLimiterDecision = {
  allowed: boolean;
  /** Milliseconds until a permit is available. Zero when one is available now. */
  waitMs: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window limiter. A window rather than a token bucket because the thing we are
 * trying not to trip is almost certainly "how many in the last minute", and a bucket
 * permits a full-size burst the instant it refills.
 */
export class RateLimiter {
  private readonly maxPerInterval: number;
  private readonly intervalMs: number;
  private readonly behaviour: LimitBehaviour;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly grants: number[] = [];
  /** Serializes acquisition so two concurrent sends cannot both read a stale window. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    if (options.maxPerInterval < 1) throw new Error("maxPerInterval must be at least 1");
    if (options.intervalMs < 1) throw new Error("intervalMs must be at least 1");
    this.maxPerInterval = options.maxPerInterval;
    this.intervalMs = options.intervalMs;
    this.behaviour = options.behaviour;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Non-mutating: what would happen if a permit were requested right now. */
  inspect(): RateLimiterDecision {
    const at = this.now();
    this.evict(at);
    if (this.grants.length < this.maxPerInterval) return { allowed: true, waitMs: 0 };
    const oldest = this.grants[0];
    if (oldest === undefined) return { allowed: true, waitMs: 0 };
    return { allowed: false, waitMs: Math.max(0, oldest + this.intervalMs - at) };
  }

  /**
   * Take a permit. Resolves once one is held. In `reject` mode, throws
   * `RateLimitExceeded` — the caller translates that into the transport's typed error,
   * so this module stays free of provider vocabulary.
   */
  async acquire(): Promise<void> {
    const run = this.queue.then(() => this.take());
    // Swallow here only so one rejection does not poison the chain for later callers;
    // `run` still rejects for the caller that owns it.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async take(): Promise<void> {
    for (;;) {
      const decision = this.inspect();
      if (decision.allowed) {
        this.grants.push(this.now());
        return;
      }
      if (this.behaviour === "reject") {
        throw new RateLimitExceeded(decision.waitMs);
      }
      await this.sleep(decision.waitMs);
    }
  }

  private evict(at: number): void {
    const cutoff = at - this.intervalMs;
    while (this.grants.length > 0) {
      const oldest = this.grants[0];
      if (oldest === undefined || oldest > cutoff) break;
      this.grants.shift();
    }
  }
}

/** Thrown by `acquire()` in `reject` mode. Translated at the transport boundary. */
export class RateLimitExceeded extends Error {
  readonly waitMs: number;

  constructor(waitMs: number) {
    super(`rate limit exceeded; retry in ${waitMs}ms`);
    this.name = "RateLimitExceeded";
    this.waitMs = waitMs;
  }
}
