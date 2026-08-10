import { describe, expect, it } from "vitest";
import { OfflineRouterProvider } from "../src/router.js";
import { runRefusalEval, runRouterEval, runVerifierEval } from "../src/eval.js";
import { REFUSAL_EVAL_CASES, ROUTER_EVAL_CASES, VERIFIER_EVAL_CASES } from "../src/eval-cases.js";

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

describe("refusal eval — release gate (Task 2): a refusal/degrade without a useful alternative is a test failure", () => {
  it("covers both real shapes a decline takes (fixed I3 string, and defaultDegrade) plus an adversarial control", () => {
    expect(REFUSAL_EVAL_CASES.length).toBeGreaterThanOrEqual(6);
    expect(REFUSAL_EVAL_CASES.some((c) => c.expectUseful === false)).toBe(true);
  });

  it("every real refusal/degrade path in this codebase offers a genuine alternative — zero failures", () => {
    const report = runRefusalEval(REFUSAL_EVAL_CASES);
    expect(report.failures).toEqual([]);
    expect(report.correct).toBe(report.evaluated);
  });
});
