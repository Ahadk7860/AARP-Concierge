import { describe, expect, it } from "vitest";

import type { EncryptedContactHandle, EncryptedTurn, Phase2PrivateRepository } from "../db/src/repository.js";
import { unsafeScopeFromUserId } from "../db/src/scope.js";
import { HandleVault, type HandleVaultKeyProvider } from "./handle-vault.js";
import { EncryptedPrivateStore, PrivateKeyCapabilityUnavailableError } from "./private-store.js";
import { TurnVault } from "./turn-vault.js";

const scope = unsafeScopeFromUserId("usr_test000000001");
const key = Buffer.alloc(32, 23);
const keys: HandleVaultKeyProvider = {
  active: async () => ({ key_version: "v1", key }),
  byVersion: async () => ({ key_version: "v1", key }),
};

class MemoryPrivateRepository implements Phase2PrivateRepository {
  handles = new Map<string, EncryptedContactHandle>();
  turns = new Map<string, EncryptedTurn>();

  async putEncryptedContactHandle(_scope: typeof scope, handle: EncryptedContactHandle): Promise<void> {
    this.handles.set(handle.contact_id, handle);
  }
  async encryptedContactHandleFor(_scope: typeof scope, contactId: string): Promise<EncryptedContactHandle | null> {
    return this.handles.get(contactId) ?? null;
  }
  async appendEncryptedTurn(_scope: typeof scope, turn: EncryptedTurn): Promise<void> { this.turns.set(turn.turn_id, turn); }
  async appendEncryptedExchangeOnce(
    _scope: typeof scope,
    inbound: EncryptedTurn,
    outbound: EncryptedTurn | null,
  ): Promise<boolean> {
    if (this.turns.has(inbound.turn_id)) return false;
    this.turns.set(inbound.turn_id, inbound);
    if (outbound !== null) this.turns.set(outbound.turn_id, outbound);
    return true;
  }
  async purgeExpiredTurns(now: Date): Promise<number> {
    let count = 0;
    for (const [id, turn] of this.turns) if (turn.expires_at <= now) { this.turns.delete(id); count += 1; }
    return count;
  }
}

describe("EncryptedPrivateStore", () => {
  it("refuses handle writes and reads without H's injected key capability", async () => {
    const repository = new MemoryPrivateRepository();
    const store = new EncryptedPrivateStore(repository, new TurnVault({ keyProvider: keys }), null);
    await expect(store.putContactHandle(scope, "h_8f21a4c0", "+16465550123"))
      .rejects.toEqual(new PrivateKeyCapabilityUnavailableError());
    await expect(store.contactHandleFor(scope, "h_8f21a4c0"))
      .rejects.toEqual(new PrivateKeyCapabilityUnavailableError());
    expect(repository.handles.size).toBe(0);
  });

  it("stores a contact handle as ciphertext and opens it only through the vault", async () => {
    const repository = new MemoryPrivateRepository();
    const handleVault = new HandleVault({ keyProvider: keys, randomBytes: (size) => Buffer.alloc(size, 4) });
    const store = new EncryptedPrivateStore(repository, new TurnVault({ keyProvider: keys }), handleVault);
    const handle = "+16465550123";
    await store.putContactHandle(scope, "h_8f21a4c0", handle);
    const row = repository.handles.get("h_8f21a4c0")!;
    expect(Buffer.concat([row.ciphertext, row.key_envelope]).toString("utf8")).not.toContain(handle);
    await expect(store.contactHandleFor(scope, "h_8f21a4c0")).resolves.toBe(handle);
  });

  it("sets both directions to exactly 90 days and commits an exchange once", async () => {
    const repository = new MemoryPrivateRepository();
    const store = new EncryptedPrivateStore(
      repository,
      new TurnVault({ keyProvider: keys, randomBytes: (size) => Buffer.alloc(size, 5) }),
      null,
    );
    const occurred = new Date("2026-08-05T12:00:00.000Z");
    const input = {
      scope,
      inbound: { turn_id: "turn_in_1", text: "private inbound", occurred_at: occurred },
      outbound: { turn_id: "turn_out_1", text: "private outbound", occurred_at: occurred },
    };
    await expect(store.persistExchangeOnce(input)).resolves.toBe(true);
    await expect(store.persistExchangeOnce(input)).resolves.toBe(false);
    expect(repository.turns.size).toBe(2);
    for (const turn of repository.turns.values()) {
      expect(turn.expires_at.toISOString()).toBe("2026-11-03T12:00:00.000Z");
      expect(turn.expires_at.getTime() - turn.occurred_at.getTime()).toBe(90 * 24 * 60 * 60 * 1_000);
      const stored = Buffer.concat([turn.ciphertext, turn.key_envelope]).toString("utf8");
      expect(stored).not.toContain("private inbound");
      expect(stored).not.toContain("private outbound");
    }
  });
});
