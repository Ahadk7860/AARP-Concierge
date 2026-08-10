import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../shared/src/index.js";
import type { UserScope } from "../db/src/index.js";
import { unsafeScopeFromUserId } from "../db/src/index.js";
import {
  DeterministicIntentAdapter,
  AutoSetupUserCreator,
} from "./inbound-adapter.js";
import type { SetupUserCreator } from "../inbound/router.js";
import { InboundRouter, SETUP_TOKEN } from "../inbound/router.js";
import type { SpectrumStreamEvent } from "../channel/src/spectrum-stream.js";
import { StubChannel } from "../shared/src/index.js";

// ---------------------------------------------------------------------------
// DeterministicIntentAdapter — boi-setup welcome
// ---------------------------------------------------------------------------

function inboundMsg(text: string): InboundMessage {
  return {
    schema_version: "inbound.v1",
    provider: "spectrum",
    provider_message_id: "msg_test_01",
    line_id: "line_a1",
    from_handle: "+15551234567",
    user_id: null,
    received_at: new Date().toISOString(),
    kind: "text",
    text,
    reply_to_message_id: null,
    protocol: "imessage",
    trace_id: null,
  };
}

const scope: UserScope = unsafeScopeFromUserId("usr_test0001");

describe("DeterministicIntentAdapter", () => {
  const adapter = new DeterministicIntentAdapter();

  it("returns handled with welcome for boi-setup", async () => {
    const result = await adapter.route(inboundMsg("boi-setup"), scope);
    expect(result.kind).toBe("handled");
    if (result.kind === "handled") {
      expect(result.intent).toBe("auto_setup");
      expect(result.reply_text).toContain("all set");
    }
  });

  it("returns handled for boi-setup with extra text", async () => {
    const result = await adapter.route(inboundMsg("boi-setup please"), scope);
    expect(result.kind).toBe("handled");
    if (result.kind === "handled") {
      expect(result.intent).toBe("auto_setup");
    }
  });

  it("returns unhandled for normal messages", async () => {
    const result = await adapter.route(inboundMsg("who should i follow up with"), scope);
    expect(result.kind).toBe("unhandled");
  });

  it("returns handled for 6-digit pairing code", async () => {
    const result = await adapter.route(inboundMsg("123456"), scope);
    expect(result.kind).toBe("handled");
    if (result.kind === "handled") {
      expect(result.intent).toBe("pairing_code");
    }
  });
});

// ---------------------------------------------------------------------------
// parseSetupToken — edge cases covered by the adapter
// ---------------------------------------------------------------------------

describe("SETUP_TOKEN matching", () => {
  it(`accepts exact match`, () => {
    expect(SETUP_TOKEN).toBe("boi-setup");
  });
});

// ---------------------------------------------------------------------------
// AutoSetupUserCreator — stub version for router tests
// ---------------------------------------------------------------------------

describe("InboundRouter with setupUser", () => {
  const stubSetup: SetupUserCreator = {
    async createFromSetup(_message: InboundMessage): Promise<UserScope | null> {
      return unsafeScopeFromUserId("usr_autocreated1");
    },
  };

  // Stub decoder that produces text messages
  const decoder = {
    decode(event: SpectrumStreamEvent): InboundMessage {
      return inboundMsg((event.payload as { text?: string } | undefined)?.text ?? "boi-setup");
    },
  };

  // Stub user resolver that returns null (unknown user)
  const unknownResolver = {
    async resolve(_msg: InboundMessage): Promise<UserScope | null> { return null; },
  };

  it("routes boi-setup from unknown user through setupUser and returns deterministic", async () => {
    const router = new InboundRouter({
      decoder,
      users: unknownResolver,
      setupUser: stubSetup,
      deterministic: {
        async route(_msg, _scope) {
          return { kind: "handled" as const, intent: "auto_setup", reply_text: "welcome from test" };
        },
      },
      chat: {
        async waitingOnMe(_msg, _scope) {
          return { schema_version: "chat_reply.v1" as const, kind: "decline" as const, text: "no", synced_through: new Date().toISOString(), licenses: [] };
        },
      },
      delivery: {
        async deliver(_input) { /* no-op */ },
      },
      privateStore: {
        async canonicalOutcomeFor() { return null; },
        async claimCanonicalOutcome(_input: unknown) {
          return { claimed: true, outcome: { event_key: "k1", delivery_key: "dk1", delivery_status: "pending" as const, outbound_text: "welcome from test" } };
        },
        async markOutcomeDelivered() { /* no-op */ },
      } as never,
    });

    const event: SpectrumStreamEvent = {
      id: "evt_001",
      payload: { text: "boi-setup" },
      cursor: "cursor_001",
    };

    const outcome = await router.route(event);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind === "deterministic") {
      expect(outcome.intent).toBe("auto_setup");
    }
  });

  it("returns unknown_user when setupUser is not configured", async () => {
    const router = new InboundRouter({
      decoder,
      users: unknownResolver,
      // No setupUser
      deterministic: new DeterministicIntentAdapter() as never,
      chat: { waitingOnMe: async () => ({ schema_version: "chat_reply.v1" as const, kind: "decline" as const, text: "x", synced_through: new Date().toISOString(), licenses: [] }) } as never,
      delivery: { deliver: async () => {} } as never,
      privateStore: {} as never,
    });

    const event: SpectrumStreamEvent = {
      id: "evt_002",
      payload: { text: "boi-setup" },
      cursor: "cursor_002",
    };

    const outcome = await router.route(event);
    expect(outcome.kind).toBe("unknown_user");
  });
});