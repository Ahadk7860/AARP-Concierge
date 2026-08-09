// R2 deletion adapter — plugs into the ExternalCardStore boundary so
// deleteUser cascades through object storage and verifies zero residue.
//
// Pattern mirrors createPrivateCardStore: a factory that returns an
// ExternalCardStore-compatible object. installR2Store() is the installation
// point in deleteUser / main.ts.

import type { ExternalCardStore } from "./repository.js";
import type { R2Store } from "../../shared/src/r2.js";

/**
 * Create an R2-backed deletion store. Wraps the R2 client with the
 * `deleteAndCount` contract that deleteUser verifies.
 *
 * `userPath(userId)` returns the prefix to delete — default is
 * `users/{user_id}/`, which matches the R2 layout in CONTENT_STORAGE.md §1.1.
 */
export function createR2DeletionStore(
  r2: R2Store,
  userPath: (userId: string) => string = (userId) => `users/${userId}/`,
): ExternalCardStore {
  return {
    name: "r2(content)",
    async deleteAndCount(userId: string): Promise<number> {
      const prefix = userPath(userId);
      await r2.deletePrefix(prefix);
      // Verify: the prefix must be empty after deletion.
      const exists = await r2.prefixExists(prefix);
      return exists ? 1 : 0;
    },
  };
}
