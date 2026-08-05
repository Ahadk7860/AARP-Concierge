import { afterEach, describe, expect, it } from "vitest";

import {
  deleteExternalCards,
  installExternalCardStore,
  ResidualUserDataError,
} from "./repository.js";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("the production external-card deletion seam", () => {
  it("uses the installed private store and verifies zero residue", async () => {
    const seen: string[] = [];
    restores.push(installExternalCardStore({
      name: "cards(private-service)",
      deleteAndCount: (userId) => { seen.push(userId); return 0; },
    }));

    await expect(deleteExternalCards("usr_delete0001"))
      .resolves.toBe("cards(private-service)");
    expect(seen).toEqual(["usr_delete0001"]);
  });

  it("fails loudly when the private store reports residue", async () => {
    restores.push(installExternalCardStore({
      name: "cards(private-service)",
      deleteAndCount: async () => 2,
    }));

    await expect(deleteExternalCards("usr_delete0002"))
      .rejects.toBeInstanceOf(ResidualUserDataError);
  });

  it("rejects invalid counts and user ids rather than verifying a guess", async () => {
    restores.push(installExternalCardStore({
      name: "cards(private-service)",
      deleteAndCount: () => Number.NaN,
    }));

    await expect(deleteExternalCards("usr_delete0003"))
      .rejects.toThrow(/invalid residue count/);
    await expect(deleteExternalCards("../../somebody"))
      .rejects.toThrow(/invalid user id/);
  });
});
