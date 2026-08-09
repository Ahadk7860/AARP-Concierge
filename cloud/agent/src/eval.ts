// Release-gate eval runners (build order item 6). Track misclassification rate (router)
// and unsupported-claim rate (verifier) — both offline, both against the deterministic
// baselines in this package, same "not shipping evidence" convention as
// cloud/chat/src/eval.ts.

import { routeQuestion, type RouterDecision, type RouterProvider } from "./router.js";
import { buildEvidencePool, verify, type ToolCallRecord } from "./verifier.js";
import type { ROUTER_EVAL_CASES, VERIFIER_EVAL_CASES } from "./eval-cases.js";

export type RouterEvalReport = {
  evaluated: number;
  correct: number;
  misclassified: number;
  misclassification_rate: number;
  failures: string[];
};

function decisionsEqual(a: RouterDecision, b: RouterDecision): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "cache_hit" && b.kind === "cache_hit") return a.intent === b.intent;
  return true;
}

export async function runRouterEval(
  cases: readonly (typeof ROUTER_EVAL_CASES)[number][],
  provider: RouterProvider,
): Promise<RouterEvalReport> {
  let correct = 0;
  const failures: string[] = [];
  for (const testCase of cases) {
    const actual = await routeQuestion(testCase.question, provider);
    if (decisionsEqual(actual, testCase.expected)) correct += 1;
    else failures.push(testCase.id);
  }
  const misclassified = cases.length - correct;
  return {
    evaluated: cases.length,
    correct,
    misclassified,
    misclassification_rate: cases.length === 0 ? 0 : misclassified / cases.length,
    failures,
  };
}

export type VerifierEvalReport = {
  evaluated: number;
  correct: number;
  unsupported_claims_missed: number; // expected reject, verifier accepted — the dangerous direction
  over_flagged: number; // expected accept, verifier rejected — the safe direction
  unsupported_claim_rate: number; // fraction of should-reject cases the verifier let through
  failures: string[];
};

export function runVerifierEval(
  cases: readonly (typeof VERIFIER_EVAL_CASES)[number][],
): VerifierEvalReport {
  let correct = 0;
  let missed = 0;
  let overFlagged = 0;
  const failures: string[] = [];
  const shouldRejectCount = cases.filter((c) => !c.expectedOk).length;

  for (const testCase of cases) {
    const record: ToolCallRecord = { tool: "eval", output: { ...testCase.toolFacts, evidence: [] } };
    const pool = buildEvidencePool([record]);
    const result = verify(testCase.draft, pool);
    if (result.ok === testCase.expectedOk) {
      correct += 1;
      continue;
    }
    failures.push(testCase.id);
    if (testCase.expectedOk) overFlagged += 1;
    else missed += 1;
  }

  return {
    evaluated: cases.length,
    correct,
    unsupported_claims_missed: missed,
    over_flagged: overFlagged,
    unsupported_claim_rate: shouldRejectCount === 0 ? 0 : missed / shouldRejectCount,
    failures,
  };
}
