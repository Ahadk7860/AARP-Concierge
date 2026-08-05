import { describe, expect, it } from "vitest";

import type { EncryptedContactHandle, EncryptedTurn, Phase2PrivateRepository } from "../db/src/repository.js";
import { unsafeScopeFromUserId } from "../db/src/scope.js";
import type { ChatReply, InboundMessage } from "../shared/src/contracts.js";
import type { HandleVaultKeyProvider } from "./handle-vault.js";
import { EncryptedPrivateStore } from "./private-store.js";
import { InboundRouter, type DeterministicIntentResult } from "./router.js";
import { TurnVault } from "./turn-vault.js";

const scope = unsafeScopeFromUserId("usr_test000000001");
const keys: HandleVaultKeyProvider = {
  active: async () => ({ key_version: "v1", key: Buffer.alloc(32, 31) }),
  byVersion: async () => ({ key_version: "v1", key: Buffer.alloc(32, 31) }),
};

class RouteRepository implements Phase2PrivateRepository {
  turns = new Map<string, EncryptedTurn>();
  async putEncryptedContactHandle(_scope: typeof scope, _handle: EncryptedContactHandle): Promise<void> {}
  async encryptedContactHandleFor(): Promise<EncryptedContactHandle | null> { return null; }
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
  async purgeExpiredTurns(): Promise<number> { return 0; }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    schema_version: "inbound.v1",
    provider: "spectrum",
    provider_message_id: "provider-message-1",
    line_id: "line-1",
    from_handle: "+16465550123",
    user_id: scope.user_id,
    received_at: "2026-08-05T12:00:00.000Z",
    kind: "text",
    text: "who am I waiting on?",
    ...overrides,
  };
}

function event(message: InboundMessage) {
  return { id: "event-1", cursor: "opaque-cursor", payload: message };
}

function harness(deterministicResult: DeterministicIntentResult) {
  const repository = new RouteRepository();
  const store = new EncryptedPrivateStore(repository, new TurnVault({ keyProvider: keys }), null);
  let deterministicCalls = 0;
  let chatCalls = 0;
  const delivered = new Set<string>();
  const reply: ChatReply = {
    schema_version: "chat_reply.v1",
    kind: "answer",
    text: "Maya is waiting on you.",
    synced_through: "2026-08-05T11:00:00.000Z",
    licenses: [{ contact_id: "h_8f21a4c0", display: "Maya", reason: "unanswered question" }],
  };
  const router = new InboundRouter({
    decoder: { decode: (streamEvent) => streamEvent.payload as InboundMessage },
    users: { resolve: async () => scope },
    deterministic: { route: async () => { deterministicCalls += 1; return deterministicResult; } },
    chat: { waitingOnMe: async () => { chatCalls += 1; return reply; } },
    delivery: { deliver: async ({ idempotency_key }) => { delivered.add(idempotency_key); } },
    privateStore: store,
    now: () => new Date("2026-08-05T12:00:01.000Z"),
  });
  return { router, repository, reply, delivered, calls: () => ({ deterministicCalls, chatCalls }) };
}

describe("InboundRouter", () => {
  it("routes existing deterministic intents before the closed chat seam", async () => {
    const test = harness({ kind: "handled", intent: "pairing", reply_text: "paired" });
    const result = await test.router.route(event(inbound({ text: "boi-4f2a91" })));
    expect(result).toMatchObject({ kind: "deterministic", intent: "pairing", reply_text: "paired" });
    expect(test.calls()).toEqual({ deterministicCalls: 1, chatCalls: 0 });
    expect(test.repository.turns.size).toBe(2);
    const stored = [...test.repository.turns.values()].map((turn) =>
      Buffer.concat([turn.ciphertext, turn.key_envelope]).toString("utf8")).join(" ");
    expect(stored).not.toContain("boi-4f2a91");
    expect(stored).not.toContain("paired");
  });

  it("uses only the injected closed waiting-on-me chat seam when intents decline", async () => {
    const test = harness({ kind: "unhandled" });
    const result = await test.router.route(event(inbound()));
    expect(result).toEqual({ kind: "chat", reply: test.reply, idempotency_key: expect.any(String) });
    expect(test.calls()).toEqual({ deterministicCalls: 1, chatCalls: 1 });
    expect(test.repository.turns.size).toBe(2);
  });

  it("returns typed ignored and unresolved outcomes without persisting", async () => {
    const test = harness({ kind: "unhandled" });
    await expect(test.router.route(event(inbound({ kind: "tapback", text: null })))).resolves
      .toEqual({ kind: "ignored", reason: "non_text" });

    const unresolved = new InboundRouter({
      decoder: { decode: (streamEvent) => streamEvent.payload as InboundMessage },
      users: { resolve: async () => null },
      deterministic: { route: async () => { throw new Error("must not route"); } },
      chat: { waitingOnMe: async () => { throw new Error("must not chat"); } },
      delivery: { deliver: async () => { throw new Error("must not deliver"); } },
      privateStore: new EncryptedPrivateStore(test.repository, new TurnVault({ keyProvider: keys }), null),
    });
    await expect(unresolved.route(event(inbound()))).resolves.toEqual({ kind: "unknown_user" });
    expect(test.repository.turns.size).toBe(0);
  });

  it("claims a provider event once so a redelivery cannot emit a second outcome", async () => {
    const test = harness({ kind: "handled", intent: "report", reply_text: "report ready" });
    const first = await test.router.route(event(inbound()));
    const second = await test.router.route(event(inbound()));
    expect(first.kind).toBe("deterministic");
    if (first.kind !== "deterministic") throw new Error("expected deterministic route");
    expect(second).toEqual({ kind: "duplicate", idempotency_key: first.idempotency_key });
    expect(test.repository.turns.size).toBe(2);
    expect(test.delivered.size).toBe(1);
  });

  it("keeps a failed decision retryable because no encrypted turn was committed", async () => {
    const repository = new RouteRepository();
    let calls = 0;
    const router = new InboundRouter({
      decoder: { decode: (streamEvent) => streamEvent.payload as InboundMessage },
      users: { resolve: async () => scope },
      deterministic: {
        route: async () => {
          calls += 1;
          if (calls === 1) throw new Error("private provider detail");
          return { kind: "handled", intent: "retry", reply_text: null };
        },
      },
      chat: { waitingOnMe: async () => { throw new Error("must not chat"); } },
      delivery: { deliver: async () => {} },
      privateStore: new EncryptedPrivateStore(repository, new TurnVault({ keyProvider: keys }), null),
    });
    await expect(router.route(event(inbound()))).rejects.toThrow();
    expect(repository.turns.size).toBe(0);
    await expect(router.route(event(inbound()))).resolves.toMatchObject({ kind: "deterministic", intent: "retry" });
    expect(repository.turns.size).toBe(1);
  });

  it("retries a failed delivery with the same idempotency key after the turns were committed", async () => {
    const repository = new RouteRepository();
    const keysSeen: string[] = [];
    let deliveryAttempts = 0;
    const router = new InboundRouter({
      decoder: { decode: (streamEvent) => streamEvent.payload as InboundMessage },
      users: { resolve: async () => scope },
      deterministic: { route: async () => ({ kind: "handled", intent: "report", reply_text: "ready" }) },
      chat: { waitingOnMe: async () => { throw new Error("must not chat"); } },
      delivery: {
        deliver: async ({ idempotency_key }) => {
          deliveryAttempts += 1;
          keysSeen.push(idempotency_key);
          if (deliveryAttempts === 1) throw new Error("transport detail");
        },
      },
      privateStore: new EncryptedPrivateStore(repository, new TurnVault({ keyProvider: keys }), null),
    });
    await expect(router.route(event(inbound()))).rejects.toThrow();
    await expect(router.route(event(inbound()))).resolves.toMatchObject({ kind: "duplicate" });
    expect(keysSeen).toHaveLength(2);
    expect(new Set(keysSeen).size).toBe(1);
    expect(repository.turns.size).toBe(2);
  });

  it("rejects malformed timestamps instead of inventing a retention boundary", async () => {
    const test = harness({ kind: "unhandled" });
    for (const received_at of ["not-a-date", "2026-02-31T12:00:00.000Z"]) {
      await expect(test.router.route(event(inbound({ received_at })))).rejects
        .toThrow("inbound_received_at_invalid");
    }
    expect(test.repository.turns.size).toBe(0);
  });
});
