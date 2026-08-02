// Identifier and secret generation. CONTRACTS.md section 6 fixes the prefixes:
// `usr_` users, `dev_` devices, `h_` contacts (HMAC hex), `g_` gists,
// `vp_` voice-pack versions, `omsg_`/`lmsg_` messages.

import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

/** Every secret and identifier here comes from node:crypto's CSPRNG. Never Math.random. */
function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function newUserId(): string {
  return `usr_${token(9)}`;
}

export function newDeviceId(): string {
  return `dev_${token(9)}`;
}

export function newBriefId(): string {
  return `brf_${token(9)}`;
}

export function newDigestId(): string {
  return `dig_${token(9)}`;
}

export function newOutboundMessageId(): string {
  return `omsg_${token(9)}`;
}

/**
 * The per-user salt. Issued once at pairing and never rotated, because rotating it
 * would orphan every contact_id the Mac has already computed.
 *
 * 32 bytes is the floor the schema enforces (`users_salt_min_32_bytes`); it is also
 * the block size HMAC-SHA256 keys to, so a longer salt buys nothing.
 */
export const USER_SALT_BYTES = 32;

export function newUserSalt(): Buffer {
  return randomBytes(USER_SALT_BYTES);
}

/** Six digits, uniform, from the CSPRNG -- not `Math.random() * 900000`. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * The cleartext device token carries the user id: `<user_id>.<secret>`.
 *
 * This is the reason authentication never needs an unscoped query. The user id is
 * parsed from the token, then the row is read with `where user_id = $1`, which is a
 * single-partition read on a table partitioned by hash(user_id). A bare opaque token
 * would have forced a global secondary index over every partition -- exactly the
 * unscoped read path the repository layer exists to make unavailable.
 *
 * The user id half is NOT a secret and is not what authenticates; the random half is,
 * and only its SHA-256 is ever stored.
 */
export function newDeviceToken(userId: string): { token: string; hash: Buffer } {
  const cleartext = `${userId}.${token(32)}`;
  return { token: cleartext, hash: hashDeviceToken(cleartext) };
}

export function hashDeviceToken(cleartext: string): Buffer {
  return createHash("sha256").update(cleartext, "utf8").digest();
}

/** Returns null when the token is not in `<user_id>.<secret>` form. */
export function userIdFromDeviceToken(cleartext: string): string | null {
  const dot = cleartext.indexOf(".");
  if (dot <= 0) return null;
  const candidate = cleartext.slice(0, dot);
  return /^usr_[A-Za-z0-9_-]{4,}$/.test(candidate) ? candidate : null;
}

/** Constant-time compare for stored token hashes. */
export function deviceTokenHashEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * contact_id = HMAC(user_salt, normalized_handle).
 *
 * Production computes this ON THE MAC (Track A); the server stores what arrives and
 * never sees a raw handle for anyone but the account holder. This function exists so
 * the cross-user test can stand in for the Mac and prove the property directly: the
 * same handle under two different salts must produce two different ids.
 */
export function contactIdForTest(userSalt: Buffer, normalizedHandle: string): string {
  const mac = createHmac("sha256", userSalt).update(normalizedHandle, "utf8").digest("hex");
  return `h_${mac.slice(0, 16)}`;
}
