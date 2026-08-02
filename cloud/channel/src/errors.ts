// Typed transport errors. Track D branches on these, so they are part of the published
// surface of the Channel abstraction.
//
// Deliberately provider-neutral: nothing in this file names a provider, because a
// consumer that has to know which vendor threw has already lost the abstraction. The
// provider's own error slug travels in `code`, as data, for logging and nothing else.

/** Base for every error a Channel raises. `code` is a lowercase snake slug per
 *  CONTRACTS.md section 6. */
export class ChannelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The line this user is assigned to is dead — not the platform, this line.
 *
 * The failure mode that actually hurts: platform uptime can read 100% while a shared
 * Apple ID is banned and every user on that line has a dead thread. Track D must treat
 * this as a migration event, never as a transient error to retry, because retrying a
 * banned line is exactly what deepens the ban.
 */
export class LineBannedError extends ChannelError {
  readonly lineId: string | null;

  constructor(lineId: string | null, message = "line banned") {
    super("line_banned", message);
    this.lineId = lineId;
  }
}

/**
 * Rate limited. `retryAfterSeconds` is null when the provider sent no `Retry-After`,
 * which is a real case and must not be papered over with an invented default — a
 * fabricated backoff is indistinguishable from a measured one at the call site.
 */
export class RateLimitedError extends ChannelError {
  readonly retryAfterSeconds: number | null;
  /** True when this track's own limiter refused, false when the provider returned 429.
   *  Track D may retry a local refusal immediately against another line; it must not
   *  do that with a remote one. */
  readonly local: boolean;

  constructor(retryAfterSeconds: number | null, local = false, message = "rate limited") {
    super("rate_limited", message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.local = local;
  }
}

/** Anything else the provider failed at: 5xx, an unrecognized body, a transport error,
 *  a rejected token. `code` carries the provider's own slug when it sent one. */
export class UpstreamError extends ChannelError {
  readonly status: number | null;
  readonly lineId: string | null;

  constructor(code: string, status: number | null, lineId: string | null = null, message?: string) {
    super(code, message ?? `upstream failure: ${code}`);
    this.status = status;
    this.lineId = lineId;
  }
}

/**
 * A send was refused before it was attempted, because the negotiated capabilities do
 * not support it.
 *
 * Refusing beats attempting-and-degrading for groups specifically: a group send that
 * silently fans out to individuals is a consent violation, not a formatting problem.
 */
export class CapabilityError extends ChannelError {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super("unsupported_capability", message);
    this.capability = capability;
  }
}

/** Every block was dropped by capability degradation, leaving nothing to send. Better
 *  than posting an empty message: degrade, never fabricate. */
export class EmptyMessageError extends ChannelError {
  constructor(message = "every block was dropped by capability degradation") {
    super("empty_message", message);
  }
}
