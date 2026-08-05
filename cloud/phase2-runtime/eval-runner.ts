// Live-model fabrication evaluation runner.
//
// Runs the 50 semantic fabrication cases through a live model provider and reports
// whether the shipping gate passes. The gate requires ZERO fabrications. Until this
// runner reports `shipping_eligible: true`, the closed-chat path must remain on the
// offline/defer provider and the follow-up draft path must remain disabled.
//
// Usage:
//   BOI_LIVE_CHAT_MODEL=gpt-4o BOI_LIVE_CHAT_API_KEY=sk-... \
//     npx tsx cloud/phase2-runtime/eval-runner.ts

import { readFileSync } from "node:fs";
import { runClosedChat } from "../chat/src/pipeline.js";
import { OfflineSemanticSelectorProvider } from "../chat/src/selector.js";
import { PHASE2_FABRICATION_CASES } from "../chat/src/fabrication-cases.js";
import type { FabricationEvalCase } from "../chat/src/eval.js";
import { liveModelConfigFromEnv, ModelChatSelectorProvider } from "./live-providers.js";
import type { DigestV2 } from "../shared/src/contracts.js";
import { join } from "node:path";

export type LiveEvalReport = {
  evaluated: number;
  fabricated: number;
  correct_answers: number;
  correct_declines: number;
  errors: number;
  shipping_eligible: boolean;
  shipping_anchor: {
    fabricated_must_equal: 0;
    passed: boolean;
    reason: string;
    failures: string[];
  };
};

function loadDigest(): DigestV2 {
  const fixturePath = join(process.cwd(), "contracts/fixtures/digest_v2/understood.json");
  return JSON.parse(readFileSync(fixturePath, "utf8")) as DigestV2;
}

export async function runLiveEval(
  cases: readonly FabricationEvalCase[],
  digest: DigestV2,
  provider: ModelChatSelectorProvider,
): Promise<LiveEvalReport> {
  let correctAnswers = 0;
  let correctDeclines = 0;
  let fabricated = 0;
  let errors = 0;
  const failures: string[] = [];

  for (const testCase of cases) {
    let reply;
    try {
      reply = await runClosedChat(testCase.question, digest, provider);
    } catch {
      errors += 1;
      failures.push(`${testCase.id}:exception`);
      continue;
    }

    if (testCase.expected.kind === "decline") {
      if (reply.kind === "decline") {
        correctDeclines += 1;
      } else {
        fabricated += 1;
        failures.push(`${testCase.id}:expected_decline_got_answer`);
      }
      continue;
    }

    if (reply.kind === "answer") {
      const actual = reply.licenses.map((l) => l.contact_id);
      const expected = testCase.expected.contact_ids;
      if (actual.length > 0 && expected.every((id: string) => actual.includes(id))) {
        correctAnswers += 1;
      } else {
        fabricated += 1;
        failures.push(`${testCase.id}:expected_answer_${expected.join(",")}_got_${actual.join(",")}`);
      }
    } else {
      // A safe false decline on an answerable case — not a fabrication, but recorded.
      failures.push(`${testCase.id}:false_decline`);
    }
  }

  const passed = fabricated === 0 && errors === 0;
  return {
    evaluated: cases.length,
    fabricated,
    correct_answers: correctAnswers,
    correct_declines: correctDeclines,
    errors,
    shipping_eligible: false, // Always false until explicitly approved
    shipping_anchor: {
      fabricated_must_equal: 0,
      passed,
      reason: passed
        ? "eval_passed_zero_fabrications_manual_review_required"
        : `fabricated_${fabricated}_errors_${errors}`,
      failures,
    },
  };
}

// Offline gate check — runs without a model, uses the OfflineSemanticSelectorProvider.
export async function runOfflineEvalGate(
  cases: readonly FabricationEvalCase[] = PHASE2_FABRICATION_CASES,
  digest: DigestV2 = loadDigest(),
): Promise<{ passed: boolean; fabricated: number; failures: string[] }> {
  const provider = new OfflineSemanticSelectorProvider();
  let fabricated = 0;
  const failures: string[] = [];

  for (const testCase of cases) {
    const reply = await runClosedChat(testCase.question, digest, provider);
    if (testCase.expected.kind === "decline") {
      if (reply.kind !== "decline") { fabricated += 1; failures.push(testCase.id); }
    } else if (reply.kind === "answer") {
      const actual = reply.licenses.map((l) => l.contact_id);
      const expected = testCase.expected.contact_ids;
      if (!expected.every((id: string) => actual.includes(id))) { fabricated += 1; failures.push(testCase.id); }
    } else {
      failures.push(`${testCase.id}:false_decline`);
    }
  }

  return { passed: fabricated === 0, fabricated, failures };
}

// CLI entry point
if (process.argv[1]?.endsWith("eval-runner.ts") || process.argv[1]?.endsWith("eval-runner.js")) {
  const config = liveModelConfigFromEnv();
  if (!config) {
    process.stderr.write("Set BOI_LIVE_CHAT_MODEL and BOI_LIVE_CHAT_API_KEY to run the live eval.\n");
    process.exit(1);
  }

  const provider = new ModelChatSelectorProvider(config);
  const digest = loadDigest();
  const report = await runLiveEval(PHASE2_FABRICATION_CASES, digest, provider);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.shipping_anchor.passed ? 0 : 1);
}
