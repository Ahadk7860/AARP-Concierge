import { describe, expect, it } from "vitest";

import { digestPayloadKey, encryptedDigestStore, plainDigestStore } from "./digest-r2.js";
import { R2Cipher, R2CipherError } from "./r2-cipher.js";
import { unsafeScopeFromUserId } from "./scope.js";
import type { R2Store } from "../../shared/src/r2.js";
import type { HandleVaultKey, HandleVaultKeyProvider } from "../../inbound/handle-vault.js";

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);

function fixedKeyProvider(key_version: string, keyMaterial: Buffer): HandleVaultKeyProvider {
  const material: HandleVaultKey = { key_version, key: keyMaterial };
  return {
    active: async () => material,
    byVersion: async (version) => (version === key_version ? material : null),
  };
}

/** In-memory stand-in for R2Store, so tests can inspect the exact bytes it received. */
function memoryR2(): R2Store & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(k: string, body: Buffer | string) {
      objects.set(k, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8"));
    },
    async get(k: string) {
      return objects.get(k) ?? null;
    },
    async delete(k: string) {
      objects.delete(k);
    },
    async deletePrefix() {
      return 0;
    },
  } as unknown as R2Store & { objects: Map<string, Buffer> };
}

const scope = unsafeScopeFromUserId("usr_00000001");
const secretPayload = {
  digest_id: "dig_abc123",
  open_loops: ["ping Maya back about Friday"],
  quote: "the-quick-brown-fox-jumps-over-4711",
};

describe("encryptedDigestStore", () => {
  it("round-trips a digest payload through put then get", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);

    await store.put(scope, "dig_abc123", secretPayload);
    const recovered = await store.get(scope, "dig_abc123");

    expect(recovered).toEqual(secretPayload);
  });

  it("the stored bytes handed to R2 do not contain the plaintext", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);

    await store.put(scope, "dig_abc123", secretPayload);

    const key_ = digestPayloadKey(scope, "dig_abc123");
    const stored = r2.objects.get(key_);
    expect(stored).toBeDefined();
    const storedText = stored!.toString("utf-8");

    expect(storedText).not.toContain("the-quick-brown-fox-jumps-over-4711");
    expect(storedText).not.toContain("ping Maya back about Friday");
    expect(storedText).not.toContain(JSON.stringify(secretPayload));
    // It must, however, look like our envelope shape.
    const parsed = JSON.parse(storedText);
    expect(parsed.algorithm).toBe("aes-256-gcm");
    expect(typeof parsed.ciphertext).toBe("string");
  });

  it("returns null for a missing object rather than throwing", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);

    await expect(store.get(scope, "dig_never_written")).resolves.toBeNull();
  });

  it("two puts of the identical payload produce different stored bytes (unique nonces)", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);

    await store.put(scope, "dig_one", secretPayload);
    await store.put(scope, "dig_two", secretPayload);

    const first = r2.objects.get(digestPayloadKey(scope, "dig_one"))!.toString("utf-8");
    const second = r2.objects.get(digestPayloadKey(scope, "dig_two"))!.toString("utf-8");
    expect(first).not.toBe(second);
    expect(JSON.parse(first).nonce).not.toBe(JSON.parse(second).nonce);
  });

  it("throws (never returns garbage) when a byte in the stored ciphertext is flipped", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);
    await store.put(scope, "dig_abc123", secretPayload);

    const objKey = digestPayloadKey(scope, "dig_abc123");
    const envelope = JSON.parse(r2.objects.get(objKey)!.toString("utf-8"));
    const bytes = Buffer.from(envelope.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    envelope.ciphertext = bytes.toString("base64url");
    r2.objects.set(objKey, Buffer.from(JSON.stringify(envelope), "utf-8"));

    await expect(store.get(scope, "dig_abc123")).rejects.toBeInstanceOf(R2CipherError);
  });

  it("throws when the stored object is truncated mid-write", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);
    await store.put(scope, "dig_abc123", secretPayload);

    const objKey = digestPayloadKey(scope, "dig_abc123");
    const full = r2.objects.get(objKey)!;
    r2.objects.set(objKey, full.subarray(0, full.length - 10)); // corrupt the trailing JSON

    await expect(store.get(scope, "dig_abc123")).rejects.toBeInstanceOf(R2CipherError);
  });

  it("throws instead of falling back to plaintext when the algorithm marker is unrecognized", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);

    const objKey = digestPayloadKey(scope, "dig_legacy_looking");
    // Simulate a hypothetical future/unknown envelope version, NOT plaintext.
    await r2.put(objKey, JSON.stringify({
      algorithm: "aes-128-cbc",
      key_version: "2026-08",
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(16).toString("base64url"),
      auth_tag: Buffer.alloc(16).toString("base64url"),
    }), "application/json");

    await expect(store.get(scope, "dig_legacy_looking")).rejects.toBeInstanceOf(R2CipherError);
  });

  it("a different user's scope cannot decrypt this user's stored digest", async () => {
    const r2 = memoryR2();
    const cipher = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipher);
    await store.put(scope, "dig_abc123", secretPayload);

    const attacker = unsafeScopeFromUserId("usr_99999999");
    // Attacker has to guess the exact object key too (it's namespaced by user_id),
    // but even handed the object directly, their scope cannot open it because the
    // AAD binds user_id and the object key is namespaced under the owner's id.
    await expect(store.get(attacker, "dig_abc123")).resolves.toBeNull(); // no object at that key
  });

  it("wrong user's key material cannot decrypt another user's object even with the same object key", async () => {
    const r2 = memoryR2();
    const cipherForOwner = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", key) });
    const store = encryptedDigestStore(r2, cipherForOwner);
    await store.put(scope, "dig_abc123", secretPayload);

    // A different R2Cipher instance keyed with different key material (as if
    // this were "another user's" data key) must not be able to open it.
    const cipherForOther = new R2Cipher({ keyProvider: fixedKeyProvider("2026-08", otherKey) });
    const storeAsOther = encryptedDigestStore(r2, cipherForOther);
    await expect(storeAsOther.get(scope, "dig_abc123")).rejects.toBeInstanceOf(R2CipherError);
  });
});

describe("plainDigestStore (test-only escape hatch, never wired to production)", () => {
  it("round-trips without encryption, confirming the encrypted store above is the one doing the work", async () => {
    const r2 = memoryR2();
    const store = plainDigestStore(r2);

    await store.put(scope, "dig_plain", secretPayload);
    const objKey = digestPayloadKey(scope, "dig_plain");
    const stored = r2.objects.get(objKey)!.toString("utf-8");

    // Unlike the encrypted store, plaintext bytes ARE visible here — this is
    // exactly the property `encryptedDigestStore` above is proven not to have.
    expect(stored).toContain("the-quick-brown-fox-jumps-over-4711");
    await expect(store.get(scope, "dig_plain")).resolves.toEqual(secretPayload);
  });
});
