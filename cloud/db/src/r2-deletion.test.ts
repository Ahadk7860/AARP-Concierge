import { afterEach, describe, expect, it } from "vitest";

import {
  deleteR2Objects,
  installR2Store,
  ResidualUserDataError,
} from "./repository.js";
import { createR2DeletionStore } from "./r2-deletion.js";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("the R2 content deletion seam", () => {
  it("uses the installed R2 store and verifies zero residue", async () => {
    const seen: Array<{ userId: string }> = [];
    const r2 = {
      deletePrefix: async (prefix: string) => { seen.push({ userId: prefix }); },
      prefixExists: async () => false, // deleted successfully
    };
    restores.push(installR2Store(createR2DeletionStore(r2 as never)));

    await expect(deleteR2Objects("usr_delete0001"))
      .resolves.toBe("r2(content)");
    expect(seen.length).toBe(1);
  });

  it("fails loudly when R2 reports residue after deletion", async () => {
    const r2 = {
      deletePrefix: async () => {},
      prefixExists: async () => true, // STILL THERE — deletion lied
    };
    restores.push(installR2Store(createR2DeletionStore(r2 as never)));

    await expect(deleteR2Objects("usr_delete0002"))
      .rejects.toBeInstanceOf(ResidualUserDataError);
  });

  it("returns null when no R2 store is installed (not a regression)", async () => {
    await expect(deleteR2Objects("usr_delete0003"))
      .resolves.toBeNull();
  });

  it("rejects invalid user ids", async () => {
    const r2 = { deletePrefix: async () => {}, prefixExists: async () => false };
    restores.push(installR2Store(createR2DeletionStore(r2 as never)));

    await expect(deleteR2Objects("../../somebody"))
      .rejects.toThrow(/invalid user id/);
  });

  it("allows setting R2 store to null (unconfigured)", () => {
    restores.push(installR2Store(null));
    expect(() => installR2Store(null)).not.toThrow();
  });
});
