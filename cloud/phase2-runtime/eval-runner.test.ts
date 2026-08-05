import { describe, expect, it } from "vitest";
import type { DigestV2 } from "../shared/src/contracts.js";
import { PHASE2_FABRICATION_CASES } from "../chat/src/fabrication-cases.js";
import { runOfflineEvalGate } from "./eval-runner.js";

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

describe("Phase 2 offline eval gate", () => {
  it("passes the offline 50-case gate with zero fabrications", async () => {
    const result = await runOfflineEvalGate(PHASE2_FABRICATION_CASES, digest);
    expect(result.passed).toBe(true);
    expect(result.fabricated).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("fails when an unanswerable case is mutated into an answerable one", async () => {
    const mutation = [{
      ...PHASE2_FABRICATION_CASES.find((c) => c.id === "u01")!,
      question: "who is waiting on me?",
    }];
    const result = await runOfflineEvalGate(mutation, digest);
    expect(result.passed).toBe(false);
    expect(result.fabricated).toBe(1);
  });

  it("does not claim shipping eligibility (model not evaluated)", async () => {
    // The offline gate passes but shipping_eligible must stay false.
    // This is enforced at the eval-runner.ts level; the offline helper
    // does not produce a shipping claim.
    const result = await runOfflineEvalGate(PHASE2_FABRICATION_CASES, digest);
    expect(result.passed).toBe(true);
    // No `shipping_eligible` field on the offline result — that field
    // only exists on the LiveEvalReport type.
    expect((result as Record<string, unknown>).shipping_eligible).toBeUndefined();
  });
});
