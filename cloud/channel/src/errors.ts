// Typed transport errors. Track D branches on these, so they are part of the published
// surface of the Channel abstraction.
//
// Deliberately provider-neutral: nothing in this file names a provider, because a
// consumer that has to know which vendor threw has already lost the abstraction.
//
// `code` is a closed union, so a provider slug cannot be put there without a type error.
// The provider's own slug and HTTP status travel in `diagnostic`, which is documented
// log-only. An earlier revision of this file passed the raw slug and `http_<status>`
// through `code` while the README told Track D to branch on it — provider coupling
// wearing a neutral name, which is worse than the obvious kind because it reads as safe.
//
// Nothing in this file names a vendor, and that is checked: the leakage grep in prompt
// 02's Definition of Done must not match this file.

/**
 * Diagnostics from the provider. **Log this; never branch on it.**
 *
 * It exists so a provider slug and status can reach an operator without reaching a
 * conditional. The moment Track D writes `if (err.diagnostic.slug === "line_degraded")`
 * the abstraction is gone — that is a vendor string in Track D's control flow, and it
 * changes when a provider we cannot see edits a response body.
 */
export type ProviderDiagnostic = {
  /** The provider's own error slug, verbatim, or null if it sent none. */
  slug: string | null;
  /** HTTP status, or null if the request never got one. */
  status: number | null;
};

/**
 * Base for every error a Channel raises.
 *
 * `code` is a **closed, provider-neutral** set — see `ChannelErrorCode`. It is the only
 * field Track D may branch on. A provider slug or raw HTTP status in `code` would be
 * provider coupling wearing a neutral name, which is worse than obvious coupling
 * because it reads as safe.
 */
export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  /** Whether retrying this exact send could plausibly succeed. Explicit rather than
   *  inferred from the code, because "which errors are retryable" is precisely the
   *  judgement a caller should not be re-deriving from slugs. */
  readonly retryable: boolean;
  readonly diagnostic: ProviderDiagnostic;

  constructor(code: ChannelErrorCode, retryable: boolean, message: string, diagnostic?: ProviderDiagnostic) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic ?? { slug: null, status: null };
  }
}

/**
 * Every code a Channel can raise. Closed on purpose: `tsc` rejects a provider slug here,
 * so the neutrality of the error surface is a type error rather than a code-review note.
 */
export type ChannelErrorCode =
  | "line_banned"
  | "line_unavailable"
  | "rate_limited"
  | "unauthorized"
  | "provider_unavailable"
  | "malformed_response"
  | "transport"
  | "no_recipient"
  | "unsupported_capability"
  | "empty_message"
  | "bad_signature"
  | "malformed_inbound";

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

  constructor(lineId: string | null, diagnostic?: ProviderDiagnostic, message = "line banned") {
    // Never retryable. Retrying a banned line is what deepens the ban.
    super("line_banned", false, message, diagnostic);
    this.lineId = lineId;
  }
}

/**
 * The line could not take the message and we cannot prove why.
 *
 * A 503 whose body we do not recognize might be a ban. Raising `LineBannedError` on that
 * evidence would trigger a migration on a guess; marking it retryable would have Track D
 * hammering a line that may already be banned. So: a distinct code, `retryable: false`,
 * and the instruction to consult `health()` rather than to retry. Same discipline as
 * `health()` reporting `degraded` when it cannot parse — do not resolve an ambiguity by
 * picking the convenient answer.
 */
export class LineUnavailableError extends ChannelError {
  readonly lineId: string | null;

  constructor(lineId: string | null, diagnostic?: ProviderDiagnostic, message = "line unavailable") {
    super("line_unavailable", false, message, diagnostic);
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

  constructor(
    retryAfterSeconds: number | null,
    local = false,
    message = "rate limited",
    diagnostic?: ProviderDiagnostic,
  ) {
    // Retryable, but only after `retryAfterSeconds`.
    super("rate_limited", true, message, diagnostic);
    this.retryAfterSeconds = retryAfterSeconds;
    this.local = local;
  }
}

/**
 * Anything else that failed: a platform 5xx, an unrecognized body, a transport error, a
 * rejected token, no recipient.
 *
 * `code` is one of a small neutral set — never the provider's slug, never `http_503`.
 * The provider's own slug and status travel in `diagnostic`, for logs.
 */
export type UpstreamCode = Extract<
  ChannelErrorCode,
  "unauthorized" | "provider_unavailable" | "malformed_response" | "transport" | "no_recipient"
>;

export class UpstreamError extends ChannelError {
  readonly lineId: string | null;

  constructor(
    code: UpstreamCode,
    retryable: boolean,
    diagnostic?: ProviderDiagnostic,
    lineId: string | null = null,
    message?: string,
  ) {
    super(code, retryable, message ?? `upstream failure: ${code}`, diagnostic);
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
    // Retrying cannot help: the line does not do this.
    super("unsupported_capability", false, message);
    this.capability = capability;
  }
}

/** Every block was dropped by capability degradation, leaving nothing to send. Better
 *  than posting an empty message: degrade, never fabricate. */
export class EmptyMessageError extends ChannelError {
  constructor(message = "every block was dropped by capability degradation") {
    super("empty_message", false, message);
  }
}
