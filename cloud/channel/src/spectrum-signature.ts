// Nine lines of HMAC, and the reason they are here rather than in the SDK.
//
// `app.webhook()` is async. `Channel.normalizeInbound` is not, and it is frozen. Widening
// the most important interface in the system to return a promise — so that every consumer
// above it becomes async, in four packages — for the sake of a signature check is the tail
// wagging the dog. `CONTRACTS.md` § 2 is explicit that a missing header must become
// `401 bad_signature` and never a 500, which is a property of the call site, not of the
// vendor's helper.
//
// The scheme, from `SPECTRUM_INTEGRATION.md`:
//
//     signed   = HMAC-SHA256(secret, `v0:${timestamp}:${rawBody}`)
//     header   = X-Spectrum-Signature: v0=<hex>
//     replay   = X-Spectrum-Timestamp, 5 minutes
//
// **Over the RAW BYTES.** A signature verifies bytes; re-serialising a parsed object
// verifies a different document, and key order alone breaks it. `CONTRACTS.md` § 2 spells
// this out because the foundation stub and Track C once disagreed about it silently.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Five minutes. Long enough for a slow retry, short enough that a captured body dies. */
export const REPLAY_WINDOW_SECONDS = 300;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "malformed" | "expired" | "mismatch" };

export function signBody(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

/**
 * Verify, with every failure named.
 *
 * The reasons are distinguished for the LOG, never for the caller's response: all four
 * are `401 bad_signature` on the wire, because telling an unauthenticated caller which
 * part of their forgery was wrong is how a signature check becomes an oracle.
 */
export function verifySignature(input: {
  secret: string;
  rawBody: Buffer | string;
  signatureHeader: string | string[] | undefined;
  timestampHeader: string | string[] | undefined;
  now?: Date;
}): SignatureCheck {
  // `string | string[] | undefined` is what a header actually is. A duplicated header is
  // a malformed request, not a reason to pick one and hope.
  const signature = typeof input.signatureHeader === "string" ? input.signatureHeader : null;
  const timestamp = typeof input.timestampHeader === "string" ? input.timestampHeader : null;
  if (signature === null || timestamp === null) return { ok: false, reason: "missing_header" };

  const match = signature.match(/^v0=([0-9a-f]{64})$/);
  if (match === null) return { ok: false, reason: "malformed" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "malformed" };
  const age = Math.abs((input.now?.getTime() ?? Date.now()) / 1000 - sentAt);
  // Absolute, so a clock skewed into the FUTURE is rejected too. A one-sided window lets
  // a forged far-future timestamp replay indefinitely.
  if (age > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "expired" };

  const expected = Buffer.from(signBody(input.secret, timestamp, input.rawBody), "utf8");
  const given = Buffer.from(match[1] as string, "utf8");
  if (expected.length !== given.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "mismatch" };
}
