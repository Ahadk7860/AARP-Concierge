// Identifier and secret generation. CONTRACTS.md section 6 fixes the prefixes:
// `usr_` users, `dev_` devices, `h_` contacts (HMAC hex), `g_` gists,
// `vp_` voice-pack versions, `omsg_`/`lmsg_` messages.

import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

/**
 * THE ALPHABETS ARE PART OF THE WIRE CONTRACT. `contracts/schema/digest.v1.json`
 * requires `^usr_[0-9a-zA-Z]{8,32}$` and `^dev_[0-9a-zA-Z]{8,32}$`; the hex-prefixed
 * ids (`h_`, `g_`, `vp_`) are `[0-9a-f]`. Neither alphabet contains `-` or `_`.
 *
 * `randomBytes(n).toString("base64url")` was used here originally and was WRONG:
 * base64url's alphabet includes `-` and `_`, so roughly one generated id in three
 * carried a character the frozen schema rejects. Nothing local caught it, because the
 * SQL CHECKs and the scope regex both used the looser `[A-Za-z0-9_-]` and no stored
 * payload is validated against its schema. It would have surfaced at integration with
 * Track A as an intermittent one-in-three failure.
 *
 * `idsMatchTheFrozenSchemas` in scope.test.ts reads the patterns out of
 * `contracts/schema/*.json` and generates a thousand of each, so a future change to
 * either the generator or the schema fails here rather than at integration.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Uniform over the alphabet by rejection sampling. `byte % 62` would be biased toward
 * the first 8 characters, which is not a security problem at these lengths but is the
 * kind of thing that is free to get right and awkward to change later.
 */
function base62(length: number): string {
  const limit = 256 - (256 % BASE62.length); // 248: discard 248..255
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += BASE62[byte % BASE62.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function hex(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

/** Every secret here comes from node:crypto's CSPRNG. Never Math.random. */
function secret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function newUserId(): string {
  return `usr_${base62(16)}`;
}

export function newDeviceId(): string {
  return `dev_${base62(16)}`;
}

/**
 * `brf_` and `dig_` are NOT in CONTRACTS.md § 6's prefix list, which fixes `usr_`,
 * `dev_`, `h_`, `g_`, `vp_`, `omsg_` and `lmsg_` and nothing else. § 4 nonetheless
 * names `digest_id` in the `digest.ingested` payload, so an id has to exist.
 *
 * Both are PROVISIONAL, recorded as a contract gap in NOTES.md, and hex so they at
 * least match the house style of the other server-minted ids. Neither appears on any
 * wire shape today. If the user rules against the prefixes, `briefs` already has the
 * natural key `(user_id, scheduled_for)` and `digests` has `(user_id, generated_at)`,
 * both unique, so both tables can drop the surrogate without a data migration.
 */
export function newBriefId(): string {
  return `brf_${hex(16)}`;
}

export function newDigestId(): string {
  return `dig_${hex(16)}`;
}

export function newOutboundMessageId(): string {
  return `omsg_${base62(16)}`;
}

// ── v3 identifiers ──

export function newPersonId(): string {
  return `p_${base62(16)}`;
}

export function newIdentityId(): string {
  return `idn_${base62(16)}`;
}

export function newInteractionId(): string {
  return `ia_${base62(16)}`;
}

export function newOutcomeId(): string {
  return `out_${base62(16)}`;
}

export function newMemoryId(): string {
  return `mem_${base62(16)}`;
}

export function newCorrectionId(): string {
  return `cor_${base62(16)}`;
}

export function newDraftEditId(): string {
  return `ded_${base62(16)}`;
}

export function newLoopId(): string {
  return `lop_${base62(16)}`;
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
  // The secret half is opaque and never crosses a schema boundary, so base64url is
  // fine here — unlike the identifiers above, which are contract-shaped.
  const cleartext = `${userId}.${secret(32)}`;
  return { token: cleartext, hash: hashDeviceToken(cleartext) };
}

export function hashDeviceToken(cleartext: string): Buffer {
  return createHash("sha256").update(cleartext, "utf8").digest();
}

/**
 * Returns null when the token is not in `<user_id>.<secret>` form.
 *
 * The pattern is the frozen one, `^usr_[0-9a-zA-Z]{8,32}$`, and it has to be. This was
 * the last survivor of the base64url defect: it accepted `[A-Za-z0-9_-]{4,}`, so
 * `usr_has-dash.secret` parsed as a well-formed user id, and `unsafeScopeFromUserId`
 * then THREW on it — turning a garbage bearer token into a 500 instead of a 401.
 * A parser accepting more than the minter can produce is not leniency, it is a
 * different validator disagreeing with the contract, which is how the original bug
 * survived three separate checks.
 */
const FROZEN_USER_ID = /^usr_[0-9a-zA-Z]{8,32}$/;

export function userIdFromDeviceToken(cleartext: string): string | null {
  const dot = cleartext.indexOf(".");
  if (dot <= 0) return null;
  const candidate = cleartext.slice(0, dot);
  return FROZEN_USER_ID.test(candidate) ? candidate : null;
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
  return `h_${mac.slice(0, 16)}`; // ^h_[0-9a-f]{8,32}$
}
