// R2-backed digest payload storage — gated behind BOI_R2_DIGEST_STORE.
//
// When enabled, digest JSONB payloads move from the `digests.payload` column to R2.
// The DB keeps metadata (digest_id, user_id, generated_at, etc.) but the payload
// column is set to '{}' — a valid JSONB empty object. Rollback is safe: set the
// flag to false and re-ingest (the Mac retries).
//
// Encryption is non-negotiable (CONTENT_STORAGE.md §2.2): every payload written
// through `encryptedDigestStore` is sealed with AES-256-GCM (see r2-cipher.ts)
// before it reaches R2. Without the master key, a bucket compromise yields only
// ciphertext. `plainDigestStore` exists only for tests that need to inspect the
// raw bytes R2 receives — it must never be reachable from production wiring.
//
// Nothing is in R2 today, so there is no legacy plaintext to read. `get` fails
// closed on anything that isn't a well-formed encrypted envelope: unparsable JSON,
// an unrecognized `algorithm` marker, a missing field, or a failed GCM tag check
// all throw. None of those cases fall back to treating the bytes as plaintext.
//
// Key rotation: the envelope carries `key_version` (see r2-cipher.ts for what
// rotating CONTACT_KEY_ENVELOPE_MASTER_KEY requires operationally).

import type { R2Store } from "../../shared/src/r2.js";
import type { UserScope } from "./scope.js";
import { R2CipherError, type EncryptedR2Envelope, type R2Cipher } from "./r2-cipher.js";

export function digestPayloadKey(scope: UserScope, digest_id: string): string {
  return `users/${scope.user_id}/digests/${digest_id}.json`;
}

export type DigestStore = {
  put(scope: UserScope, digest_id: string, payload: unknown): Promise<void>;
  get(scope: UserScope, digest_id: string): Promise<unknown | null>;
};

/**
 * Store without encryption — direct R2 pass-through. Test-only: nothing in
 * production wiring may construct this, since CONTENT_STORAGE.md §2.2 makes
 * encryption non-negotiable for message-derived content.
 */
export function plainDigestStore(r2: R2Store): DigestStore {
  return {
    async put(scope, digest_id, payload) {
      const key = digestPayloadKey(scope, digest_id);
      await r2.put(key, JSON.stringify(payload), "application/json");
    },
    async get(scope, digest_id) {
      const key = digestPayloadKey(scope, digest_id);
      const buf = await r2.get(key);
      if (buf === null) return null;
      return JSON.parse(buf.toString("utf-8"));
    },
  };
}

/**
 * Store with envelope encryption — every blob is sealed before it touches R2.
 *
 * `get` fails closed: a read that isn't valid JSON, isn't shaped like
 * `EncryptedR2Envelope`, carries an unrecognized `algorithm`, or fails GCM tag
 * verification throws `R2CipherError` — it never returns partial or
 * silently-wrong plaintext, and it never falls back to treating the bytes as
 * an unencrypted payload.
 */
export function encryptedDigestStore(
  r2: R2Store,
  cipher: R2Cipher,
): DigestStore {
  return {
    async put(scope, digest_id, payload) {
      const key = digestPayloadKey(scope, digest_id);
      const plain = Buffer.from(JSON.stringify(payload), "utf-8");
      const envelope = await cipher.seal(
        { user_id: scope.user_id, object_key: key },
        plain,
      );
      await r2.put(key, JSON.stringify(envelope), "application/json");
    },
    async get(scope, digest_id) {
      const key = digestPayloadKey(scope, digest_id);
      const buf = await r2.get(key);
      if (buf === null) return null;

      let raw: unknown;
      try {
        raw = JSON.parse(buf.toString("utf-8"));
      } catch {
        // Corrupted/truncated object — fail loudly, never guess at plaintext.
        throw new R2CipherError("decryption_failed");
      }

      const plain = await cipher.open(
        { user_id: scope.user_id, object_key: key },
        raw as EncryptedR2Envelope,
      );
      return JSON.parse(plain.toString("utf-8"));
    },
  };
}
