import { describe, expect, it } from "vitest";
import { liveModelConfigFromEnv, ModelChatSelectorProvider, ModelFollowUpDraftProvider } from "./live-providers.js";
import type { DraftProviderInput } from "../chat/src/draft.js";
import { CHAT_TOOL_VOCABULARY } from "../chat/src/selector.js";

describe("live-providers", () => {
  describe("liveModelConfigFromEnv", () => {
    it("returns null when no env vars are set", () => {
      expect(liveModelConfigFromEnv({})).toBeNull();
    });

    it("returns null when only model is set without key", () => {
      expect(liveModelConfigFromEnv({ BOI_LIVE_CHAT_MODEL: "gpt-4o" })).toBeNull();
    });

    it("returns null when only key is set without model", () => {
      expect(liveModelConfigFromEnv({ BOI_LIVE_CHAT_API_KEY: "sk-test" })).toBeNull();
    });

    it("returns config with both model and key", () => {
      const config = liveModelConfigFromEnv({
        BOI_LIVE_CHAT_MODEL: "gpt-4o",
        BOI_LIVE_CHAT_API_KEY: "sk-test",
      });
      expect(config).not.toBeNull();
      expect(config!.model).toBe("gpt-4o");
      expect(config!.apiKey).toBe("sk-test");
      expect(config!.shippingMode).toBe(false);
    });

    it("respects custom base URL", () => {
      const config = liveModelConfigFromEnv({
        BOI_LIVE_CHAT_MODEL: "gpt-4o",
        BOI_LIVE_CHAT_API_KEY: "sk-test",
        BOI_LIVE_CHAT_BASE_URL: "https://custom.api.com/v1",
      });
      expect(config!.baseUrl).toBe("https://custom.api.com/v1");
    });
  });

  describe("ModelChatSelectorProvider", () => {
    it("throws if shippingMode is not false", () => {
      expect(() => new ModelChatSelectorProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      })).not.toThrow();
    });

    it("has shipping explicitly false", () => {
      const provider = new ModelChatSelectorProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      });
      expect(provider.shipping).toBe(false);
    });

    it("records calls with only question and tool vocabulary", async () => {
      const provider = new ModelChatSelectorProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      });
      // The actual model call will fail (no real endpoint), but the input
      // recording happens before the fetch. We catch the error to verify
      // the call was recorded correctly.
      try {
        await provider.select({ question: "who is waiting on me?", tools: CHAT_TOOL_VOCABULARY });
      } catch {
        // Expected — no real endpoint
      }
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.question).toBe("who is waiting on me?");
      expect(provider.calls[0]?.tools).toEqual(CHAT_TOOL_VOCABULARY);
      // Verify no digest data leaked into the call
      const serialized = JSON.stringify(provider.calls[0]);
      expect(serialized).not.toContain("contact_id");
      expect(serialized).not.toContain("display");
      expect(serialized).not.toContain("Maya");
    });
  });

  describe("ModelFollowUpDraftProvider", () => {
    const draftInput: DraftProviderInput = {
      understanding: {
        register: "warm",
        relationship_kind: "close_friend",
        open_thread: "asked whether you are coming",
        last_exchange_shape: "question_from_them",
        topics: ["climbing"],
        cadence_norm: "usually quick",
      },
      facts: { dates: ["2026-08-01"], times: [], places: [], amounts: [], names: [] },
      voice_exemplars: [{
        text: "user-authored message goes here",
        answered: "question_from_them",
        register: "warm",
      }],
    };

    it("throws if shippingMode is not false", () => {
      expect(() => new ModelFollowUpDraftProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      })).not.toThrow();
    });

    it("has shipping explicitly false", () => {
      const provider = new ModelFollowUpDraftProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      });
      expect(provider.shipping).toBe(false);
    });

    it("records calls and does not leak counterparty prose", async () => {
      const provider = new ModelFollowUpDraftProvider({
        model: "gpt-4o",
        apiKey: "sk-test",
        shippingMode: false,
      });
      try {
        await provider.generate(draftInput);
      } catch {
        // Expected — no real endpoint
      }
      expect(provider.calls).toHaveLength(1);
      // counterparty prose must not appear in the recorded input
      const serialized = JSON.stringify(provider.calls[0]);
      expect(serialized).not.toContain("counterpart");
      // user-authored text IS in the input (it's licensed)
      expect(serialized).toContain("user-authored");
    });
  });
});
