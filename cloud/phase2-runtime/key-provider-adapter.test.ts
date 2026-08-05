import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { adaptKeyProvider } from "./key-provider-adapter.js";
import type { HandleEnvelopeKeyProvider } from "../api/src/main.js";

function makeProvider(key?: Buffer): HandleEnvelopeKeyProvider {
  const held = Buffer.from(key ?? randomBytes(32));
  return {
    keyId: createHash("sha256").update(held).digest("hex").slice(0, 16),
    key: () => Buffer.from(held),
  };
}

describe("key-provider-adapter", () => {
  it("active returns the current key version and 32-byte key", async () => {
    const source = makeProvider();
    const adapter = adaptKeyProvider(source);
    const key = await adapter.active();
    expect(key.key_version).toBe(source.keyId);
    expect(key.key).toBeInstanceOf(Buffer);
    expect(key.key.length).toBe(32);
  });

  it("byVersion matches the current keyId", async () => {
    const source = makeProvider();
    const adapter = adaptKeyProvider(source);
    const found = await adapter.byVersion(source.keyId);
    expect(found).not.toBeNull();
    expect(found!.key_version).toBe(source.keyId);
    expect(found!.key.length).toBe(32);
  });

  it("byVersion returns null for an unknown version", async () => {
    const adapter = adaptKeyProvider(makeProvider());
    const found = await adapter.byVersion("unknown_version");
    expect(found).toBeNull();
  });

  it("each call to active returns a distinct key buffer", async () => {
    const source = makeProvider();
    const adapter = adaptKeyProvider(source);
    const a = await adapter.active();
    const b = await adapter.active();
    expect(a.key).not.toBe(b.key);
    expect(a.key).toEqual(b.key);
  });
});
