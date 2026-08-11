import { describe, expect, it } from "vitest";

import { R2Cipher, R2CipherError, type R2CipherContext } from "./r2-cipher.js";
import type { HandleVaultKey, HandleVaultKeyProvider } from "../../inbound/handle-vault.js";

const keyA = Buffer.alloc(32, 7);
const keyB = Buffer.alloc(32, 9);

function fixedKeyProvider(key_version: string, key: Buffer): HandleVaultKeyProvider {
  const material: HandleVaultKey = { key_version, key };
  return {
    active: async () => material,
    byVersion: async (version) => (version === key_version ? material : null),
  };
}

const context: R2CipherContext = {
  user_id: "usr_00000001",
  object_key: "users/usr_00000001/digests/dig_abc123.json",
};

describe("R2Cipher", () => {
  it("round-trips: seal then open returns the original plaintext", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ open_loops: ["ping Maya back"], secret: "do not leak" }), "utf-8");

    const envelope = await cipher.seal(context, plaintext);
    const recovered = await cipher.open(context, envelope);

    expect(recovered.equals(plaintext)).toBe(true);
  });

  it("the stored bytes do not contain the plaintext", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const secretMarker = "the-quick-brown-fox-jumps-over-the-lazy-dog-4711";
    const plaintext = Buffer.from(JSON.stringify({ note: secretMarker }), "utf-8");

    const envelope = await cipher.seal(context, plaintext);
    // This is exactly what storeDigestPayload hands to r2.put(): JSON.stringify(envelope).
    const bytesHandedToR2 = Buffer.from(JSON.stringify(envelope), "utf-8");

    expect(bytesHandedToR2.includes(secretMarker)).toBe(false);
    expect(bytesHandedToR2.toString("utf-8")).not.toContain(secretMarker);
    // Also assert on the raw ciphertext buffer itself, not just the JSON wrapper.
    const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64url");
    expect(ciphertextBytes.includes(secretMarker)).toBe(false);
  });

  it("two identical plaintexts produce different ciphertext (unique nonces)", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ same: "payload" }), "utf-8");

    const first = await cipher.seal(context, plaintext);
    const second = await cipher.seal(context, plaintext);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("throws on a tampered ciphertext byte", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: 1 }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const bytes = Buffer.from(envelope.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...envelope, ciphertext: bytes.toString("base64url") };

    await expect(cipher.open(context, tampered)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("throws on a tampered auth tag byte", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: 1 }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const bytes = Buffer.from(envelope.auth_tag, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...envelope, auth_tag: bytes.toString("base64url") };

    await expect(cipher.open(context, tampered)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("throws on a tampered nonce byte", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: 1 }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const bytes = Buffer.from(envelope.nonce, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...envelope, nonce: bytes.toString("base64url") };

    await expect(cipher.open(context, tampered)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("throws on a truncated ciphertext (object cut short)", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: "not so short a value here" }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const bytes = Buffer.from(envelope.ciphertext, "base64url");
    const truncated = { ...envelope, ciphertext: bytes.subarray(0, Math.max(1, bytes.length - 4)).toString("base64url") };

    await expect(cipher.open(context, truncated)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("a wrong user's key context cannot decrypt another user's object", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ private: "only usr_00000001 should read this" }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const otherUserContext: R2CipherContext = { ...context, user_id: "usr_99999999" };
    await expect(cipher.open(otherUserContext, envelope)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("a different key entirely (simulating another user's data key) cannot decrypt", async () => {
    const sealer = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const opener = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyB) });
    const plaintext = Buffer.from(JSON.stringify({ private: "sealed under keyA" }), "utf-8");
    const envelope = await sealer.seal(context, plaintext);

    await expect(opener.open(context, envelope)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("fails closed on an unknown algorithm marker instead of treating it as plaintext", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: 1 }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const bogus = { ...envelope, algorithm: "aes-128-cbc" as never };
    await expect(cipher.open(context, bogus)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("fails closed when the key version is unknown to the provider (e.g. after rotation without retained old keys)", async () => {
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", keyA) });
    const plaintext = Buffer.from(JSON.stringify({ x: 1 }), "utf-8");
    const envelope = await cipher.seal(context, plaintext);

    const rotated = { ...envelope, key_version: "2099-01-rotated" };
    await expect(cipher.open(context, rotated)).rejects.toBeInstanceOf(R2CipherError);
  });

  it("remains readable across rotation as long as the old key is still retrievable by version", async () => {
    // Simulates a key provider that has been extended to retain prior versions.
    const oldMaterial: HandleVaultKey = { key_version: "2026-08", key: keyA };
    const newMaterial: HandleVaultKey = { key_version: "2026-09", key: keyB };
    const rotatingProvider: HandleVaultKeyProvider = {
      active: async () => newMaterial,
      byVersion: async (version) => {
        if (version === oldMaterial.key_version) return oldMaterial;
        if (version === newMaterial.key_version) return newMaterial;
        return null;
      },
    };

    const beforeRotation = new R2Cipher({
      keyProvider: { active: async () => oldMaterial, byVersion: rotatingProvider.byVersion },
    });
    const plaintext = Buffer.from(JSON.stringify({ x: "written before rotation" }), "utf-8");
    const envelope = await beforeRotation.seal(context, plaintext);
    expect(envelope.key_version).toBe("2026-08");

    const afterRotation = new R2Cipher({ keyProvider: rotatingProvider });
    const recovered = await afterRotation.open(context, envelope);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});
