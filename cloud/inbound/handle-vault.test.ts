import { describe, expect, it } from "vitest";

import { HandleVault, HandleVaultError, type HandleVaultKeyProvider } from "./handle-vault.js";
import { composeTapToSend, type DraftDelivery } from "./tap-to-send.js";

const key = Buffer.alloc(32, 7);
const keys: HandleVaultKeyProvider = {
  active: async () => ({ key_version: "2026-08", key }),
  byVersion: async (version) => version === "2026-08" ? { key_version: version, key } : null,
};

describe("HandleVault", () => {
  it("uses AES-256-GCM with a random nonce and versioned injected key", async () => {
    const vault = new HandleVault({ keyProvider: keys });
    const handle = "+1 (646) 555-0123";
    const first = await vault.seal(handle);
    const second = await vault.seal(handle);

    expect(first.algorithm).toBe("aes-256-gcm");
    expect(first.key_version).toBe("2026-08");
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain(handle);
    await expect(vault.open(first)).resolves.toBe(handle);
  });

  it("rejects altered ciphertext and never includes the handle in a loggable error", async () => {
    const vault = new HandleVault({ keyProvider: keys, randomBytes: (size) => Buffer.alloc(size, 1) });
    const handle = "person+private@example.test";
    const encrypted = await vault.seal(handle);
    const altered = { ...encrypted, auth_tag: `${encrypted.auth_tag.slice(0, -1)}A` };

    await expect(vault.open(altered)).rejects.toEqual(new HandleVaultError("decryption_failed"));
    await vault.open(altered).catch((error: unknown) => {
      expect(String(error)).not.toContain(handle);
    });
  });

  it("does not expose a provider failure or invalid key through its error", async () => {
    const handle = "hidden-recipient@example.test";
    const vault = new HandleVault({
      keyProvider: { active: async () => { throw new Error(`provider leaked ${handle}`); }, byVersion: async () => null },
    });

    await vault.seal(handle).catch((error: unknown) => {
      expect(String(error)).toBe("Error: handle_encryption_failed");
      expect(String(error)).not.toContain(handle);
    });
  });
});

describe("tap-to-send delivery", () => {
  const text = "hi & are you free at 7? ☕";

  it("always returns copyable text and encodes both the recipient and body", () => {
    const delivery: DraftDelivery = {
      schema_version: "draft_delivery.v1",
      contact_id: "h_8f21a4c0",
      text,
      recipient: { kind: "resolved", handle: "+1 646&555@example.test" },
    };

    expect(composeTapToSend(delivery)).toEqual({
      text,
      recipient_state: "resolved",
      sms_link: "sms:%2B1%20646%26555%40example.test&body=hi%20%26%20are%20you%20free%20at%207%3F%20%E2%98%95",
    });
  });

  it("degrades unavailable recipients to copyable text instead of dropping the draft", () => {
    const delivery: DraftDelivery = {
      schema_version: "draft_delivery.v1",
      contact_id: "h_8f21a4c0",
      text,
      recipient: { kind: "unavailable" },
    };

    expect(composeTapToSend(delivery)).toEqual({ text, recipient_state: "unavailable", sms_link: null });
  });
});
