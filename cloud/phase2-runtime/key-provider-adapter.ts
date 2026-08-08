// Adapts H's synchronous HandleEnvelopeKeyProvider to I's async HandleVaultKeyProvider.
// This is a deliberate non-leaking adapter: the synchronous key() call is never memoized
// or cached; each call to active() or byVersion() returns a fresh copy so the consumer
// cannot hold a reference that survives key rotation.

import type { HandleVaultKey, HandleVaultKeyProvider } from "../inbound/handle-vault.js";
import type { HandleEnvelopeKeyProvider } from "../api/src/main.js";

export function adaptKeyProvider(source: HandleEnvelopeKeyProvider): HandleVaultKeyProvider {
  return {
    async active(): Promise<HandleVaultKey> {
      return { key_version: source.keyId, key: source.key() };
    },
    async byVersion(keyVersion: string): Promise<HandleVaultKey | null> {
      if (keyVersion !== source.keyId) return null;
      return { key_version: source.keyId, key: source.key() };
    },
  };
}
