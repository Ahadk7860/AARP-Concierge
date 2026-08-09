import { describe, expect, it } from "vitest";
import { OfflineRouterProvider } from "../src/router.js";
import { runRouterEval, runVerifierEval } from "../src/eval.js";
import { ROUTER_EVAL_CASES, VERIFIER_EVAL_CASES } from "../src/eval-cases.js";

describe("router eval — release gate: misclassification rate against the offline baseline", () => {
  it("covers every frozen §4.2a intent plus agent and refuse lanes", () => {
    expect(ROUTER_EVAL_CASES.length).toBeGreaterThanOrEqual(18);
    const cacheHitIntents = new Set(
      ROUTER_EVAL_CASES
        .map((c) => c.expected)
        .filter((d): d is Extract<typeof d, { kind: "cache_hit" }> => d.kind === "cache_hit")
        .map((d) => d.intent),
    );
    expect(cacheHitIntents).toEqual(new Set(["waiting_on_me", "drifting", "overdue", "morning_brief"]));
  });

  it("the offline baseline provider achieves zero misclassifications on this corpus", async () => {
    const report = await runRouterEval(ROUTER_EVAL_CASES, new OfflineRouterProvider());
    expect(report).toEqual({
      evaluated: ROUTER_EVAL_CASES.length,
      correct: ROUTER_EVAL_CASES.length,
      misclassified: 0,
      misclassification_rate: 0,
      failures: [],
    });
  });
});

describe("verifier eval — release gate: unsupported-claim rate against the deterministic verifier", () => {
  it("the verifier achieves zero unsupported-claim leakage on this labeled corpus", () => {
    const report = runVerifierEval(VERIFIER_EVAL_CASES);
    expect(report.unsupported_claims_missed).toBe(0);
    expect(report.unsupported_claim_rate).toBe(0);
    expect(report.over_flagged).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.correct).toBe(report.evaluated);
  });
});
