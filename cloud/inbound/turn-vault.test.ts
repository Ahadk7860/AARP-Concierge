import { describe, expect, it } from "vitest";

import type { HandleVaultKeyProvider } from "./handle-vault.js";
import { TurnVault, TurnVaultError, type TurnVaultContext } from "./turn-vault.js";

const key = Buffer.alloc(32, 19);
const keys: HandleVaultKeyProvider = {
  active: async () => ({ key_version: "v7", key }),
  byVersion: async (version) => version === "v7" ? { key_version: version, key } : null,
};

describe("TurnVault", () => {
  const context: TurnVaultContext = { user_id: "usr_test000000001", turn_id: "turn_01", direction: "inbound" };

  it("encrypts a user-to-Boi turn and reveals no plaintext in its envelope", async () => {
    const vault = new TurnVault({ keyProvider: keys });
    const text = "this is a private user turn";
    const encrypted = await vault.seal(context, text);
    expect(JSON.stringify(encrypted)).not.toContain(text);
    await expect(vault.open(context, encrypted)).resolves.toBe(text);
  });

  it.each([
    { ...context, user_id: "usr_other00000001" },
    { ...context, turn_id: "turn_02" },
    { ...context, direction: "outbound" as const },
  ])("rejects AAD context swaps without leaking plaintext: $direction/$turn_id", async (swapped) => {
    const vault = new TurnVault({ keyProvider: keys, randomBytes: (size) => Buffer.alloc(size, 3) });
    const text = "private swap canary";
    const encrypted = await vault.seal(context, text);
    await expect(vault.open(swapped, encrypted)).rejects.toEqual(new TurnVaultError("decryption_failed"));
    await vault.open(swapped, encrypted).catch((error: unknown) => {
      expect(String(error)).not.toContain(text);
    });
  });

  it("binds the key version and collapses provider failures to a safe error", async () => {
    const text = "provider must not echo this";
    const vault = new TurnVault({
      keyProvider: {
        active: async () => { throw new Error(text); },
        byVersion: async () => null,
      },
    });
    await vault.seal(context, text).catch((error: unknown) => {
      expect(String(error)).toBe("Error: turn_encryption_failed");
      expect(String(error)).not.toContain(text);
    });
  });
});
