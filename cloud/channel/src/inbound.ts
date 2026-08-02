// Inbound webhook verification and normalization into `inbound.v1`.
//
// Provider-neutral by construction: this file knows about signatures, kinds and the
// frozen `inbound.v1` shape, and nothing about any particular vendor's field names. The
// provider-specific extraction — which key holds the message id, what the type strings
// are — lives with the adapter that speaks that provider. Nothing here names a vendor,
// and that is checked by the leakage grep in prompt 02's Definition of Done.
//
// THE ORDER MATTERS: verify, then parse. An unverified body is attacker-controlled input,
// and every line that interprets it before the signature is checked is a line running on
// somebody else's data. So `normalize` refuses to look at the contents until the bytes
// have been authenticated.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage } from "../../shared/src/contracts.js";
import { ChannelError } from "./errors.js";

// ---------------------------------------------------------------------------
// Errors — a bad signature must be distinguishable from a bad body
// ---------------------------------------------------------------------------

/**
 * The bytes are not authentic. Distinct from `InboundParseError` on purpose: one is a
 * security event worth alerting on, the other is a schema drift worth a bug report, and
 * collapsing them into one class means neither gets the response it deserves.
 */
export class SignatureError extends ChannelError {
  constructor(message = "bad_signature") {
    super("bad_signature", false, message);
  }
}

/** The bytes are authentic but the contents are not a message we understand. */
export class InboundParseError extends ChannelError {
  readonly detail: string;

  constructor(detail: string) {
    super("malformed_inbound", false, `malformed inbound webhook: ${detail}`);
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Verification — swappable, because the real scheme is unconfirmed
// ---------------------------------------------------------------------------

/**
 * CONTRACTS.md § 11 item 2: the signature scheme is a placeholder and has never been
 * checked against a live webhook from the provider. So it is an injectable strategy rather than a
 * hardcoded algorithm — when the real scheme arrives it is a new verifier, not surgery
 * on the normalizer.
 */
export type SignatureVerifier = {
  /** Named so a log can say which scheme accepted or rejected a body. */
  readonly name: string;
  verify(rawBody: Buffer, signature: string): boolean;
};

/**
 * HMAC-SHA256 over the raw bytes, hex, `sha256=` prefixed — the placeholder scheme.
 *
 * Comparison is constant-time. A byte-by-byte compare that returns early leaks how much
 * of a forged signature was correct, which is enough to reconstruct a valid one a byte at
 * a time. That is a real vulnerability in a webhook endpoint, not a nitpick.
 */
export function hmacSha256Verifier(secret: string, prefix = "sha256="): SignatureVerifier {
  return {
    name: "hmac-sha256",
    verify(rawBody: Buffer, signature: string): boolean {
      const expected = Buffer.from(`${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
      const actual = Buffer.from(signature);
      // timingSafeEqual throws on a length mismatch, so the lengths are compared first —
      // and length is not a secret.
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(expected, actual);
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export type InboundKind = InboundMessage["kind"];
export type InboundProtocol = NonNullable<InboundMessage["protocol"]>;

/**
 * What a provider adapter must pull out of its own webhook body. Everything optional is
 * genuinely optional in `inbound.v1`; everything required here is required there.
 */
export type ExtractedInbound = {
  providerMessageId: string;
  lineId: string;
  fromHandle: string;
  kind: InboundKind;
  receivedAt: string | null;
  text: string | null;
  tapback: string | null;
  replyToMessageId: string | null;
  protocol: InboundProtocol | null;
  traceId: string | null;
};

/** Extracts a provider's webhook body. Throws `InboundParseError` if it cannot. */
export type InboundExtractor = (body: unknown) => ExtractedInbound;

/** Resolves a handle to a Boi user. Pairing owns this and it is Track D's; absent a
 *  resolver, `user_id` is null, which `inbound.v1` explicitly allows. */
export type UserResolver = (fromHandle: string) => string | null;

export type NormalizeOptions = {
  verifier: SignatureVerifier;
  extract: InboundExtractor;
  provider: InboundMessage["provider"];
  resolveUser?: UserResolver;
  now?: () => Date;
};

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function toBuffer(rawBody: unknown): Buffer {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  // Refusing an already-parsed object is the whole point. Re-serializing it to check a
  // signature would compare a signature against bytes that were never on the wire — key
  // order and whitespace normalize away — and would pass every test written the same
  // wrong way before failing on the first real webhook.
  throw new SignatureError("raw body required: pass the exact bytes received, not a parsed object");
}

export function normalizeInbound(rawBody: unknown, signature: string, options: NormalizeOptions): InboundMessage {
  const bytes = toBuffer(rawBody);

  // Verify FIRST. Nothing below this line runs on unauthenticated input.
  if (!options.verifier.verify(bytes, signature)) throw new SignatureError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new InboundParseError("body is not valid JSON");
  }

  const fields = options.extract(parsed);
  const now = options.now ?? (() => new Date());

  // `as_of` on every fact, end to end. If the provider sent no usable timestamp we stamp
  // our own receipt time rather than emitting null — the schema requires one, and the
  // moment we received it is a true statement we can make.
  const receivedAt =
    fields.receivedAt !== null && ISO_Z.test(fields.receivedAt) ? fields.receivedAt : now().toISOString();

  const message: InboundMessage = {
    schema_version: "inbound.v1",
    provider: options.provider,
    provider_message_id: fields.providerMessageId,
    line_id: fields.lineId,
    from_handle: fields.fromHandle,
    // null until pairing resolves it. Track D's job, and an unknown handle is a normal
    // state — the first message from a new number is always unknown.
    user_id: options.resolveUser?.(fields.fromHandle) ?? null,
    received_at: receivedAt,
    kind: fields.kind,
    text: fields.text,
    tapback: fields.tapback,
    reply_to_message_id: fields.replyToMessageId,
    protocol: fields.protocol,
    trace_id: fields.traceId !== null && W3C_TRACEPARENT.test(fields.traceId) ? fields.traceId : null,
  };
  return message;
}

// ---------------------------------------------------------------------------
// Shared extraction helpers, used by provider adapters
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(source: Record<string, unknown>, keys: string[], label: string): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new InboundParseError(`missing ${label} (looked for ${keys.join(", ")})`);
}

export function optionalString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export function readProtocol(value: unknown): InboundProtocol | null {
  return value === "imessage" || value === "rcs" || value === "sms" ? value : null;
}
