import { describe, expect, it } from "vitest";
import type { DigestV2 } from "../../shared/src/contracts.js";
import { runClosedChat } from "./pipeline.js";
import {
  CHAT_TOOL_VOCABULARY,
  RecordedSelectorProvider,
  parseSelectorOutput,
  selectClosedChatQuery,
} from "./selector.js";

function digest(): DigestV2 {
  return {
    schema_version: "digest.v2",
    user_id: "usr_demo0001",
    device_id: "dev_demo0001",
    generated_at: "2026-08-01T09:14:00Z",
    synced_through: "2026-08-01T09:10:00Z",
    corpus: {
      message_count: 2,
      thread_count: 1,
      first_message_at: null,
      last_message_at: null,
      span_days: 1,
      health: "healthy",
      as_of: "2026-08-01T09:10:00Z",
    },
    relationships: [{
      contact_id: "h_8f21a4c0",
      display: "Maya",
      is_group: false,
      message_count: 2,
      sent_count: 1,
      received_count: 1,
      first_contact_at: null,
      last_contact_at: null,
      days_since_last_contact: 2,
      momentum_90d: 1,
      initiation_ratio: 0.5,
      archetype: null,
      as_of: "2026-08-01T09:10:00Z",
      understanding: {
        register: "warm",
        relationship_kind: "close_friend",
        open_thread: "asked whether you are coming, unanswered",
        last_exchange_shape: "question_from_them",
        topics: ["climbing"],
        cadence_norm: "usually replies within an hour",
        voice_exemplars: [{
          text: "private user-authored exemplar",
          answered: "question_from_them",
          register: "warm",
        }],
      },
    }],
    whole_life: { as_of: "2026-08-01T09:10:00Z" },
  };
}

describe("closed chat selector", () => {
  it("shows the provider only the question and one literal tool vocabulary", async () => {
    const question = "who should i follow up with?";
    const provider = new RecordedSelectorProvider(new Map([
      [question, { kind: "query", name: "waiting_on_me", limit: 2 }],
    ]));

    await selectClosedChatQuery(question, provider);

    expect(provider.calls).toEqual([{ question, tools: CHAT_TOOL_VOCABULARY }]);
    expect(Object.keys(provider.calls[0] ?? {}).sort()).toEqual(["question", "tools"]);
    expect(JSON.stringify(provider.calls)).not.toContain("Maya");
    expect(JSON.stringify(provider.calls)).not.toContain("voice_exemplars");
    expect(CHAT_TOOL_VOCABULARY.map((tool) => tool.name)).toEqual(["waiting_on_me"]);
  });

  it("accepts only waiting_on_me with an integer limit from 1 through 3", () => {
    expect(parseSelectorOutput({ kind: "query", name: "waiting_on_me", limit: 1 })).toEqual({
      kind: "query",
      query: { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 1 },
    });
    for (const limit of [0, 4, 1.5, "3"]) {
      expect(parseSelectorOutput({ kind: "query", name: "waiting_on_me", limit }).kind).toBe("decline");
    }
  });

  it("fails closed on an unknown tool, a free-form query, and an injected unlicensed row", async () => {
    const mutations: unknown[] = [
      { kind: "query", name: "longest_silent", limit: 3 },
      { kind: "query", sql: "select * from relationships" },
      {
        kind: "query",
        name: "waiting_on_me",
        limit: 3,
        rows: [{ contact_id: "h_00000009", display: "Nora", open_thread: "unlicensed" }],
      },
    ];

    for (const output of mutations) {
      expect(parseSelectorOutput(output).kind).toBe("decline");
      const provider = new RecordedSelectorProvider(new Map([["question", output]]));
      const reply = await runClosedChat("question", digest(), provider);
      expect(reply.kind).toBe("decline");
      expect(reply.licenses).toEqual([]);
      expect(reply.text).not.toContain("Nora");
      expect(reply.text).not.toContain("unlicensed");
    }
  });

  it("keeps selection separate from deterministic execution and reply licensing", async () => {
    const question = "who is waiting on me?";
    const provider = new RecordedSelectorProvider(new Map([
      [question, { kind: "query", name: "waiting_on_me", limit: 3 }],
    ]));

    const reply = await runClosedChat(question, digest(), provider);

    expect(reply.kind).toBe("answer");
    expect(reply.licenses).toEqual([{
      contact_id: "h_8f21a4c0",
      display: "Maya",
      reason: "asked whether you are coming, unanswered",
    }]);
    expect(reply.text).toContain("As of Aug 1, 2026 at 9:10 AM UTC.");
    expect(JSON.stringify(provider.calls)).not.toContain("h_8f21a4c0");
  });
});
