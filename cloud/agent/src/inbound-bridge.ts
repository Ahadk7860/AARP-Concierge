// Track H — wires the v3 agent path (router → agent loop → verifier → bubble delivery,
// V3_ARCHITECTURE.md §2) into the LIVE inbound entry point, behind
// `BOI_AGENT_PATH_ENABLED` (runtime.ts). This file is the "beside it, not instead of it"
// seam HANDOFF_CLAUDE.md asks for: it implements the SAME `ClosedChatPort` interface
// (cloud/inbound/router.ts) that the old closed-vocabulary `ClosedChatAdapter`
// (cloud/phase2-runtime/inbound-adapter.ts) implements, so the swap at the call site is a
// single conditional, not a rewrite of `InboundRouter` or anything it depends on.
//
// ⚠️ KNOWN GAP, load-bearing — read before wiring this into anything real (also logged in
// INTERFACES.md and the Track H report):
//
// `ClosedChatPort.waitingOnMe()` returns exactly ONE `ChatReply` — the OLD wire contract
// (cloud/inbound/router.ts → `InboundReplyDeliveryPort.deliver()`) has no concept of
// multiple bubbles. But the whole point of §2's "MULTI-BUBBLE DELIVERY — first bubble
// ASAP, remainder as ready" is that the agent loop calls `sink.deliver()` once per
// verifier-cleared paragraph and `sink.end()` when done (agent-loop.ts's
// `deliverBubbles`). Bridging into the old single-reply contract necessarily COLLAPSES
// that back into one delivery — this bridge joins the bubbles with blank lines rather
// than dropping any of them, which is honest but not the product behavior §2 describes.
//
// Real multi-bubble delivery over live inbound traffic needs one of:
//   (a) `InboundRouter`/`ClosedChatPort` widened to accept a `BubbleSink` instead of
//       returning a single `ChatReply`, or
//   (b) a new entry point that bypasses `InboundRouter`'s single-reply path entirely and
//       calls `runAgentTurn` with the REAL `openBubbleSink` (Track F's, not the stub) once
//       it reaches `main`.
// Neither exists yet. This bridge exists so the flag is REACHABLE from real inbound
// traffic today (collapsed to one reply) while the real fix is tracked separately.
//
// SECOND KNOWN GAP: `ChatReply` (cloud/shared/src/contracts.ts) is still v1-shaped —
// `kind: "answer" | "decline"`, no `evidence` field — even though Track A shipped
// `chat_reply.v2`'s `kind: "open"` + `evidence` in `cloud/api/src/schemas.ts`. This bridge
// therefore downgrades a verified agent reply to `kind: "answer"` with `licenses: []`
// rather than the v2 `open` shape, because `cloud/shared/src/contracts.ts` is shared
// (coordinate-in-INTERFACES.md) and widening its `ChatReply` union was judged out of
// scope for phase 1. Logged in INTERFACES.md; the real fix is extending that type.
//
// THIRD KNOWN GAP: the `AgentStore` passed in here has no real backing — Track E's §4.1
// tables are not merged into this branch. Until they land, this bridge (and the flag it
// sits behind) answers every question with NO relationship data, which is safe (never
// fabricates — the verifier still runs and there is simply nothing to find) but not
// useful. `BOI_AGENT_PATH_ENABLED` stays unset in every real deploy until Track E merges.

import type { InboundMessage } from "../../shared/src/index.js";
import type { UserScope } from "../../db/src/scope.js";
import type { ChatReply } from "../../shared/src/contracts.js";
import type { ClosedChatPort } from "../../inbound/router.js";
import { runAgentTurn, type AgentTurnDeps, type AgentTurnLogger } from "./agent-loop.js";
import { InMemoryBubbleSink } from "./bubble-sink-stub.js";
import type { AgentStore } from "./ports.js";
import { DegradedDeviceSearchPort } from "./ports.js";
import { NullApprovalTokenStore } from "./tools.js";
import { buildAgentRuntime } from "./runtime.js";

export type AgentClosedChatBridgeDeps = {
  store: AgentStore;
  env?: NodeJS.ProcessEnv;
  log?: AgentTurnLogger;
};

/**
 * Adapts the v3 agent path to `ClosedChatPort`, per the gap notes above. Every reply is
 * `chat_reply.v1`-shaped (`answer`/`decline`, `licenses: []`) — never fabricated, because
 * the text always came from `runAgentTurn`'s verifier-cleared output, just packaged in the
 * older envelope until `ChatReply` is widened.
 */
export class AgentClosedChatBridge implements ClosedChatPort {
  constructor(private readonly deps: AgentClosedChatBridgeDeps) {}

  async waitingOnMe(message: InboundMessage, scope: UserScope): Promise<ChatReply> {
    const question = message.text ?? "";
    const sink = new InMemoryBubbleSink();
    const runtime = buildAgentRuntime(this.deps.env);
    const turnDeps: AgentTurnDeps = {
      router: runtime.router,
      agentModel: runtime.agentModel,
      escalation: runtime.escalation,
      toolContext: {
        scope,
        store: this.deps.store,
        deviceSearch: new DegradedDeviceSearchPort(),
        approvals: new NullApprovalTokenStore(),
      },
      sink,
      log: this.deps.log,
    };

    const result = await runAgentTurn(question, turnDeps);
    const nowIso = new Date().toISOString();

    // §2 "MULTI-BUBBLE DELIVERY" collapse — see the file-level gap note. Joining on a
    // blank line preserves the paragraph boundaries the agent loop already chose without
    // inventing new punctuation.
    const joined = sink.delivered.map((b) => b.text).join("\n\n").trim();

    if (result.kind === "refuse" || result.kind === "agent_no_output" || joined === "") {
      return {
        schema_version: "chat_reply.v1",
        kind: "decline",
        text: joined !== "" ? joined : "I'm not confident I can answer that safely — want to rephrase, or ask something more specific?",
        synced_through: nowIso,
        licenses: [],
      };
    }

    return {
      schema_version: "chat_reply.v1",
      kind: "answer",
      text: joined,
      synced_through: nowIso,
      licenses: [],
    };
  }
}
