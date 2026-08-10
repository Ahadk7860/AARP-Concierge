// The agent loop (V3_ARCHITECTURE.md §2): router → tool-calling turns on
// gemini-2.5-flash-lite → verifier (I1, I2) → escalation to gemini-2.5-pro on rejection,
// once → multi-bubble delivery of ONLY verifier-cleared text.
//
// I1 is enforced structurally here, not just by convention: `runAgentTurn` has exactly one
// call to `runVerifiedTurn`, and the only two things that reach `sink.deliver()` are its
// "verified" text or its "degraded" text — both already passed (or were built directly
// from) the verifier. There is no third code path to delivery.

import { routeQuestion, type RouterDecision, type RouterProvider } from "./router.js";
import { invokeTool, type ToolContext, ToolInputError } from "./tools.js";
import { TOOL_NAMES, type ToolName } from "./tools.js";
import { buildEvidencePool, runVerifiedTurn, type ToolCallRecord, type VerifiedTurnOutcome } from "./verifier.js";
import type { BubbleSink } from "../../channel/src/progressive.js";
import type { ChatMessage, ToolCall } from "./gemini-client.js";
import type { Intent } from "../../shared/src/intents.js";
import type { EvidenceRef } from "./types.js";

const MAX_TOOL_ROUNDS = 6;

// SHOULD-FIX (review): only the round limit existed as a guard on a hung tool call — no
// per-tool timeout, so one stuck call (a device search that never resolves, a store query
// against a slow connection) could stall the whole turn up to the model's own request
// timeout. search_messages gets §4.3's own 4s budget (device round-trip + FTS/embedding
// search); every other tool is local SQL/in-memory and gets a tighter 2s.
const DEFAULT_TOOL_TIMEOUT_MS = 2000;
const TOOL_TIMEOUT_MS: Partial<Record<ToolName, number>> = {
  search_messages: 4000,
};

class ToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`tool_timeout:${tool}:${ms}ms`);
    this.name = "ToolTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(tool, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

/** One round of the tool-calling loop: given the running message transcript, either
 * return more tool calls to make, or a final draft. Implemented by AgentModelProvider. */
export interface AgentModelProvider {
  turn(messages: ChatMessage[]): Promise<{ content: string | null; tool_calls: ToolCall[] | null }>;
}

/** The one escalation call (gemini-2.5-pro), given the violation-naming instruction. */
export interface EscalationProvider {
  regenerate(messages: ChatMessage[], violationSummary: string): Promise<string>;
}

export type PrecomputedAnswerLookup = (intent: Intent) => Promise<{ text: string } | null>;

/**
 * Observability hook (review: "we cannot debug a fabrication in production without this").
 * Structural metadata only, matching the rest of this codebase's logging discipline
 * (compose-runtime.ts: "Operational metadata only — no payload, no provider error
 * strings") — question text and generated prose are never logged here. The one deliberate
 * exception is `verifier_outcome`'s violations: a claim's `value` there is the FABRICATED
 * text the verifier rejected, not real user or counterpart content, and is exactly what's
 * needed to diagnose why a fabrication happened.
 */
export type AgentTurnLogger = (event: string, fields: Record<string, unknown>) => void;

export type AgentTurnDeps = {
  router: RouterProvider;
  agentModel: AgentModelProvider;
  escalation: EscalationProvider;
  toolContext: ToolContext;
  sink: BubbleSink;
  precomputed?: PrecomputedAnswerLookup;
  refusalText?: string;
  maxToolRounds?: number;
  log?: AgentTurnLogger;
};

export type AgentTurnResult =
  | { kind: "cache_hit"; intent: Intent; delivered: boolean }
  | { kind: "refuse"; delivered: boolean }
  // `evidence` (Track H): every {source,id} ref returned by this turn's tool calls, i.e.
  // `buildEvidencePool(calls).refs` — the SAME pool the verifier itself checked `outcome`
  // against. Exposed so a caller wiring a real wire format (e.g. chat_reply.v2's `evidence`
  // field, cloud/agent/src/inbound-bridge.ts) doesn't have to re-run tool calls or guess;
  // it is exactly the provenance the verifier already computed and is discarding otherwise.
  | { kind: "agent"; outcome: VerifiedTurnOutcome; toolCalls: number; evidence: readonly EvidenceRef[] }
  | { kind: "agent_no_output"; toolCalls: number };

const DEFAULT_REFUSAL = "I'm not confident I can answer that safely — want to rephrase, or ask something more specific?";

const SYSTEM_PROMPT = `You are Boi, a personal relationship assistant. You answer using ONLY the tools available to you — never from your own general knowledge about the specific people in the user's life. Every person name, handle, date, or number you state must come from a tool result you received this turn.

Call tools to gather what you need, then answer in plain conversational prose. If a tool returns no usable evidence for part of the question, say so honestly rather than guessing. Never call send_message without an approval_token the user explicitly gave this turn — draft_message is always safe to use instead.`;

function toolNameFromCall(call: ToolCall): ToolName | null {
  return (TOOL_NAMES as readonly string[]).includes(call.function.name)
    ? (call.function.name as ToolName)
    : null;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function runToolCallingLoop(
  question: string,
  deps: AgentTurnDeps,
): Promise<{ draft: string; calls: ToolCallRecord[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  const calls: ToolCallRecord[] = [];
  const maxRounds = deps.maxToolRounds ?? MAX_TOOL_ROUNDS;

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await deps.agentModel.turn(messages);

    if (result.tool_calls === null || result.tool_calls.length === 0) {
      return { draft: result.content ?? "", calls };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.tool_calls });

    for (const call of result.tool_calls) {
      const name = toolNameFromCall(call);
      let outputText: string;
      if (name === null) {
        outputText = JSON.stringify({ error: "unknown_tool", evidence: [] });
        deps.log?.("tool_call", { tool: call.function.name, ok: false, error: "unknown_tool" });
      } else {
        const startedAt = Date.now();
        const timeoutMs = TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
        try {
          const input = parseToolArguments(call.function.arguments);
          const output = await withTimeout(invokeTool(deps.toolContext, name, input), timeoutMs, name);
          calls.push({ tool: name, output });
          outputText = JSON.stringify(output);
          deps.log?.("tool_call", {
            tool: name,
            ok: true,
            evidence_count: Array.isArray(output.evidence) ? output.evidence.length : 0,
            duration_ms: Date.now() - startedAt,
          });
        } catch (err) {
          const reason = err instanceof ToolInputError ? err.message
            : err instanceof ToolTimeoutError ? "tool_timeout"
            : "tool_call_failed";
          outputText = JSON.stringify({ error: reason, evidence: [] });
          deps.log?.("tool_call", { tool: name, ok: false, error: reason, duration_ms: Date.now() - startedAt });
        }
      }
      messages.push({ role: "tool", content: outputText, tool_call_id: call.id });
    }
  }

  // Ran out of rounds without a final answer. Fail closed to no draft — the caller
  // treats an empty draft plus zero evidence as "nothing to verify, nothing to say."
  return { draft: "", calls };
}

/**
 * Runs one full agent turn end to end: route, then (on `agent`) tool-call, verify, and
 * deliver ONLY verifier-cleared bubbles. `cache_hit` and `refuse` never touch the model
 * loop or the verifier — they have nothing generated to verify.
 */
export async function runAgentTurn(question: string, deps: AgentTurnDeps): Promise<AgentTurnResult> {
  const decision: RouterDecision = await routeQuestion(question, deps.router);
  deps.log?.("router_decision", {
    lane: decision.kind,
    intent: decision.kind === "cache_hit" ? decision.intent : undefined,
  });

  if (decision.kind === "refuse") {
    await deliverSingleBubble(deps.sink, deps.refusalText ?? DEFAULT_REFUSAL);
    return { kind: "refuse", delivered: true };
  }

  if (decision.kind === "cache_hit") {
    const lookup = deps.precomputed;
    const cached = lookup !== undefined ? await lookup(decision.intent) : null;
    if (cached !== null) {
      await deliverSingleBubble(deps.sink, cached.text);
      return { kind: "cache_hit", intent: decision.intent, delivered: true };
    }
    // A cache miss is never an error (§4.2a) — fall through to the agent path exactly as
    // if the router had said `agent`.
  }

  const { draft, calls } = await runToolCallingLoop(question, deps);
  if (draft.trim() === "") {
    // No final draft — either the model made no tool calls and said nothing, or (just as
    // possible) it made tool calls but the loop exhausted MAX_TOOL_ROUNDS before producing
    // a final answer. Either way there is no unverified prose to guard against, but there
    // is also nothing honest to say beyond a refusal-shaped decline. Gating on the draft
    // alone (not `calls.length === 0`) matters: a non-empty `calls` with an empty draft is
    // exactly the exhausted-rounds case, and it must not fall through to verify("") — an
    // empty string has zero claims to check and would verify "ok", shipping a blank bubble.
    await deliverSingleBubble(deps.sink, deps.refusalText ?? DEFAULT_REFUSAL);
    return { kind: "agent_no_output", toolCalls: calls.length };
  }

  const outcome = await runVerifiedTurn(
    draft,
    calls,
    async (violationSummary) => {
      const escalationMessages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
        { role: "assistant", content: draft },
        { role: "user", content: violationSummary },
      ];
      return deps.escalation.regenerate(escalationMessages, violationSummary);
    },
  );

  deps.log?.("verifier_outcome", {
    status: outcome.status,
    attempt: outcome.status === "verified" ? outcome.attempt : undefined,
    violations: outcome.status === "degraded"
      ? outcome.violations.map((v) => ({ kind: v.claim.kind, value: v.claim.value, reason: v.reason }))
      : undefined,
  });

  await deliverBubbles(deps.sink, outcome.text);
  return { kind: "agent", outcome, toolCalls: calls.length, evidence: buildEvidencePool(calls).refs };
}

async function deliverSingleBubble(sink: BubbleSink, text: string): Promise<void> {
  await sink.deliver({ type: "text", text });
  await sink.end();
}

/**
 * Splits ALREADY-VERIFIED text into bubbles on paragraph breaks and delivers each as it
 * finalizes, per §4.4's "call deliver() as each bubble finalises, end() when done." Splitting
 * happens only after the verifier has cleared the whole text — never before, so no bubble
 * can ever carry unverified prose.
 *
 * Deliberately refuses to deliver an empty bubble no matter what the caller passes in: if
 * `verifiedText` is blank (or entirely whitespace), `paragraphs` is empty and NOTHING is
 * delivered — there is no fallback branch that reintroduces the original text. Every path
 * that can produce an empty `verifiedText` today is caught earlier (the empty-draft guard
 * in `runAgentTurn`, and `defaultDegrade`'s own non-empty fallback string), but this
 * function does not trust that as its only line of defense.
 */
async function deliverBubbles(sink: BubbleSink, verifiedText: string): Promise<void> {
  const paragraphs = verifiedText.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "");
  for (const bubble of paragraphs) {
    await sink.deliver({ type: "text", text: bubble });
  }
  await sink.end();
}
