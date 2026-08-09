// R2-backed digest payload storage — gated behind BOI_R2_DIGEST_STORE.
//
// When enabled, digest JSONB payloads move from the `digests.payload` column to R2.
// The DB keeps metadata (digest_id, user_id, generated_at, etc.) but the payload
// column is set to '{}' — a valid JSONB empty object. Rollback is safe: set the
// flag to false and re-ingest (the Mac retries).

import type { R2Store } from "../../shared/src/r2.js";
import type { UserScope } from "./scope.js";

export function digestPayloadKey(scope: UserScope, digest_id: string): string {
  return `users/${scope.user_id}/digests/${digest_id}.json`;
}

export async function storeDigestPayload(
  r2: R2Store,
  scope: UserScope,
  digest_id: string,
  payload: unknown,
): Promise<void> {
  const key = digestPayloadKey(scope, digest_id);
  await r2.put(key, JSON.stringify(payload), "application/json");
}

export async function loadDigestPayload(
  r2: R2Store,
  scope: UserScope,
  digest_id: string,
): Promise<unknown | null> {
  const key = digestPayloadKey(scope, digest_id);
  const buf = await r2.get(key);
  if (buf === null) return null;
  return JSON.parse(buf.toString("utf-8"));
}
