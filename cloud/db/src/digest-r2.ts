// R2-backed digest payload storage — gated behind BOI_R2_DIGEST_STORE.
//
// When enabled, digest JSONB payloads move from the `digests.payload` column to R2.
// The DB keeps metadata (digest_id, user_id, generated_at, etc.) but the payload
// column is set to '{}' — a valid JSONB empty object. Rollback is safe: set the
// flag to false and re-ingest (the Mac retries).
//
// Encryption is optional and recommended. When a cipher is provided, every payload
// is sealed with AES-256-GCM before reaching R2. Without the master key, a bucket
// compromise yields only ciphertext blobs.

import type { R2Store } from "../../shared/src/r2.js";
import type { UserScope } from "./scope.js";
import type { R2Cipher } from "./r2-cipher.js";

export function digestPayloadKey(scope: UserScope, digest_id: string): string {
  return `users/${scope.user_id}/digests/${digest_id}.json`;
}

export type DigestStore = {
  put(scope: UserScope, digest_id: string, payload: unknown): Promise<void>;
  get(scope: UserScope, digest_id: string): Promise<unknown | null>;
};

/**
 * Store without encryption — direct R2 pass-through.
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
      const raw = JSON.parse(buf.toString("utf-8"));
      // Detect encrypted blobs: must be an object with the algorithm field.
      if (raw !== null && typeof raw === "object" && raw.algorithm === "aes-256-gcm") {
        const plain = await cipher.open(
          { user_id: scope.user_id, object_key: key },
          raw,
        );
        return JSON.parse(plain.toString("utf-8"));
      }
      // Unencrypted — backwards-compatible read.
      return raw;
    },
  };
}
