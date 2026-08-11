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
// `ClosedChatPort.waitingOnMe()` returns exactly ONE reply — the OLD wire contract
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
//       returning a single reply, or
//   (b) a new entry point that bypasses `InboundRouter`'s single-reply path entirely and
//       calls `runAgentTurn` with the REAL `openBubbleSink` (Track F's, not the stub) once
//       it reaches `main`.
// Neither exists yet. This bridge exists so the flag is REACHABLE from real inbound
// traffic today (collapsed to one reply) while the real fix is tracked separately.
//
// SECOND KNOWN GAP — CLOSED 2026-08-09 by Track A (`f00ef1f`): `cloud/shared/src/contracts.ts`
// now exports `ChatReplyV2`/`EvidenceRef`/`ChatReplyAny`, additive to v1, compile-time-asserted
// bidirectionally equal to `z.infer<typeof chatReplyV2Schema>`. `ClosedChatPort.waitingOnMe()`'s
// return type is widened `ChatReply` -> `ChatReplyAny` (cloud/inbound/router.ts, Track H). This
// bridge now returns the REAL `chat_reply.v2` `kind: "open"` shape with the REAL `evidence`
// refs the verifier actually checked the delivered text against
// (`AgentTurnResult`'s new `evidence` field, `buildEvidencePool(calls).refs` — see
// agent-loop.ts) — nothing is downgraded or discarded anymore. `refuse`/`agent_no_output`
// still map to v1's `decline` (fixed strings, no tool calls, nothing to cite as evidence for
// — `evidence` would be vacuously `[]` and the v1 shape says exactly that already, so there is
// no reason to carry the extra schema_version tag for a lane that never touches the verifier).
//
// THIRD KNOWN GAP: the `AgentStore` passed in here has no real backing — Track E's §4.1
// tables are not merged into this branch. Until they land, this bridge (and the flag it
// sits behind) answers every question with NO relationship data, which is safe (never
// fabricates — the verifier still runs and there is simply nothing to find) but not
// useful. `BOI_AGENT_PATH_ENABLED` stays unset in every real deploy until Track E merges.

import type { InboundMessage } from "../../shared/src/index.js";
import type { UserScope } from "../../db/src/scope.js";
import type { ChatReplyAny } from "../../shared/src/contracts.js";
import type { ClosedChatPort } from "../../inbound/router.js";
import { runAgentTurn, type AgentTurnDeps, type AgentTurnLogger } from "./agent-loop.js";
import { InMemoryBubbleSink } from "./in-memory-bubble-sink.js";
import type { AgentStore, DeviceSearchPort } from "./ports.js";
import { DegradedGeneralKnowledgeProvider, NullApprovalTokenStore, type GeneralKnowledgeProvider } from "./tools.js";
import { buildAgentRuntime, deviceSearchPortFor } from "./runtime.js";

export type AgentClosedChatBridgeDeps = {
  store: AgentStore;
  env?: NodeJS.ProcessEnv;
  log?: AgentTurnLogger;
  /** Test-only override for the device-search port, bypassing the installed
   * `DeviceGateway` singleton (runtime.ts's `installDeviceGateway`/`deviceSearchPortFor`).
   * Real production callers never set this: `cloud/api/src/main.ts` installs the live
   * gateway once at boot and every bridge instance reaches it automatically through
   * `deviceSearchPortFor(scope)`. Exists so a test can hand `search_messages` a scripted
   * device response without standing up a real `DeviceGateway` + socket pair. */
  deviceSearch?: DeviceSearchPort;
  /** Test-only override for the model-facing seams, bypassing `buildAgentRuntime(env)`.
   * Real production callers never set this — `env` alone selects live vs. offline. Exists
   * because the offline fallback (no live key) never produces tool calls, so it cannot
   * exercise the `kind: "open"` + evidence success path; a test needs a scripted model to
   * reach `runAgentTurn`'s "agent" branch without a live Gemini key. */
  runtimeOverride?: Pick<AgentTurnDeps, "router" | "agentModel" | "escalation"> & {
    /** Test-only override for the `general` tool's backing provider. Optional — a test
     * exercising `refuse`/`agent_no_output`/non-`general` tool paths need not supply one. */
    general?: GeneralKnowledgeProvider;
  };
};

/**
 * Adapts the v3 agent path to `ClosedChatPort`. A verified (or verifier-degraded) agent
 * reply ships as `chat_reply.v2`'s `kind: "open"` carrying the REAL evidence refs the
 * verifier checked it against — never fabricated, and never discarded anymore. `refuse`
 * and `agent_no_output` (nothing generated, nothing to verify) ship as v1's `decline`.
 */
export class AgentClosedChatBridge implements ClosedChatPort {
  constructor(private readonly deps: AgentClosedChatBridgeDeps) {}

  async waitingOnMe(message: InboundMessage, scope: UserScope): Promise<ChatReplyAny> {
    const question = message.text ?? "";
    const sink = new InMemoryBubbleSink();
    const runtime = this.deps.runtimeOverride ?? buildAgentRuntime(this.deps.env);
    const turnDeps: AgentTurnDeps = {
      router: runtime.router,
      agentModel: runtime.agentModel,
      escalation: runtime.escalation,
      toolContext: {
        scope,
        store: this.deps.store,
        deviceSearch: this.deps.deviceSearch ?? deviceSearchPortFor(scope),
        approvals: new NullApprovalTokenStore(),
        general: runtime.general ?? new DegradedGeneralKnowledgeProvider(),
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
        text: joined !== ""
          ? joined
          : "I'm not confident I can answer that safely. I can look up someone's relationship status, search your messages, check open loops, see who's overdue, or answer a general-knowledge question — want to try one of those instead?",
        synced_through: nowIso,
        licenses: [],
      };
    }

    // result.kind === "cache_hit" never reaches here (handled by `joined === ""` above only
    // when the cache lookup itself came back empty; a real cache hit has non-empty `joined`
    // and is genuinely fine to ship as `open` — it is still text this turn actually produced,
    // just not agent/tool-sourced, so `evidence: []` is correct rather than a lie).
    const evidence = result.kind === "agent" ? [...result.evidence] : [];

    return {
      schema_version: "chat_reply.v2",
      kind: "open",
      text: joined,
      synced_through: nowIso,
      licenses: [],
      evidence,
    };
  }
}
