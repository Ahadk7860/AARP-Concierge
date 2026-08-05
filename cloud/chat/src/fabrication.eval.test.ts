import { describe, expect, it } from "vitest";
import type { DigestV2 } from "../../shared/src/contracts.js";
import { runFabricationEval } from "./eval.js";
import { PHASE2_FABRICATION_CASES } from "./fabrication-cases.js";

const digest: DigestV2 = {
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
      voice_exemplars: [],
    },
  }],
  whole_life: { as_of: "2026-08-01T09:10:00Z" },
};

describe("Phase 2 fifty-question fabrication evaluation", () => {
  it("contains exactly 50 mixed recorded cases", () => {
    expect(PHASE2_FABRICATION_CASES).toHaveLength(50);
    expect(new Set(PHASE2_FABRICATION_CASES.map((testCase) => testCase.id)).size).toBe(50);
    expect(new Set(PHASE2_FABRICATION_CASES.map((testCase) => testCase.category))).toEqual(new Set([
      "answerable",
      "unanswerable",
      "ambiguous_name",
      "unsupported",
      "injection",
      "cross_contact",
    ]));
  });

  it("ships only when the recorded run has zero fabrications", async () => {
    const report = await runFabricationEval(PHASE2_FABRICATION_CASES, digest);
    expect(report).toEqual({
      evaluated: 50,
      answered_correctly: 15,
      declined_correctly: 35,
      fabricated: 0,
      shipping_anchor: { fabricated_must_equal: 0, passed: true },
      failures: [],
    });
  });

  it("marks an answered unsupported question as fabrication and fails the shipping anchor", async () => {
    const mutation = [{
      ...PHASE2_FABRICATION_CASES.find((testCase) => testCase.id === "u01")!,
      recorded_selector_output: { kind: "query", name: "waiting_on_me", limit: 1 },
    }];
    const report = await runFabricationEval(mutation, digest);
    expect(report.fabricated).toBe(1);
    expect(report.shipping_anchor).toEqual({ fabricated_must_equal: 0, passed: false });
    expect(report.failures).toEqual(["u01"]);
  });
});
