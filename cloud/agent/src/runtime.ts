// Assembly point for the v3 agent path, built BESIDE the live cloud/phase2-runtime /
// cloud/inbound closed-vocabulary path — not wired into it. Track H integrates this behind
// a feature flag once the verifier has demonstrably held (V3_ARCHITECTURE.md §6, "the old
// closed-vocabulary path stays live until H proves the verifier holds. Do not delete it
// early."). This file does not import from, and is not imported by, cloud/phase2-runtime
// or cloud/inbound — that boundary is deliberate, not an oversight.

import { agentModelConfigFromEnv, type AgentModelConfig } from "./model-config.js";
import { LiveAgentModelProvider, LiveEscalationProvider, LiveGeneralKnowledgeProvider } from "./live-agent-providers.js";
import { ModelRouterProvider, OfflineRouterProvider, type RouterProvider } from "./router.js";
import type { AgentModelProvider, EscalationProvider } from "./agent-loop.js";
import type { AgentStore } from "./ports.js";
import { DegradedDeviceSearchPort, type DeviceSearchPort } from "./ports.js";
import { DegradedGeneralKnowledgeProvider, NullApprovalTokenStore, type ApprovalTokenStore, type GeneralKnowledgeProvider, type SendPort } from "./tools.js";
import { PostgresAgentStore } from "./postgres-agent-store.js";

/** BOI_AGENT_PATH_ENABLED=1 gates the v3 agent path. Absent or any other value = disabled,
 * so a misconfigured deploy fails closed to the proven-live selector/reply/waiting-on-me
 * path rather than silently switching everyone onto the unproven one. */
export function agentPathEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["BOI_AGENT_PATH_ENABLED"] === "1";
}

export type AgentRuntime = {
  router: RouterProvider;
  agentModel: AgentModelProvider;
  escalation: EscalationProvider;
  /** Backs the `general` tool (tools.ts, §2's "general → model knowledge / web" row).
   * `DegradedGeneralKnowledgeProvider` when no live model key is configured — it throws on
   * every call, which `general()` turns into an honest `degraded: "unavailable"` rather
   * than fabricating an answer. */
  general: GeneralKnowledgeProvider;
  modelConfig: AgentModelConfig | null;
};

/**
 * Builds the model-facing seams from env. When no live model key is configured, falls back
 * to the offline router baseline and throws-on-call model/escalation/general stand-ins —
 * matching the existing `liveModelConfigFromEnv` "absent means offline" convention
 * (live-providers.ts) rather than crashing at boot. Track H supplies `AgentStore` /
 * `DeviceSearchPort` / `ApprovalTokenStore` / `SendPort` separately per request, scoped to
 * the caller's UserScope.
 */
export function buildAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const modelConfig = agentModelConfigFromEnv(env);
  if (modelConfig === null) {
    return {
      router: new OfflineRouterProvider(),
      agentModel: { turn: async () => ({ content: null, tool_calls: null }) },
      escalation: { regenerate: async () => "" },
      general: new DegradedGeneralKnowledgeProvider(),
      modelConfig: null,
    };
  }
  return {
    router: new ModelRouterProvider(modelConfig),
    agentModel: new LiveAgentModelProvider(modelConfig),
    escalation: new LiveEscalationProvider(modelConfig),
    general: new LiveGeneralKnowledgeProvider(modelConfig),
    modelConfig,
  };
}

/** Placeholder ports for local/dev use before Track C's device link is wired in for real.
 * Never used when agentPathEnabledFromEnv() is false. */
export type UnwiredPorts = {
  deviceSearch: DeviceSearchPort;
  approvals: ApprovalTokenStore;
};

export function unwiredPorts(): UnwiredPorts {
  return { deviceSearch: new DegradedDeviceSearchPort(), approvals: new NullApprovalTokenStore() };
}

/**
 * Track E's §4.1 tables (persons/identities/interactions/open_loops/
 * relationship_metrics_daily/relationship_edges/memories) are merged, so `AgentStore` now
 * has a real Postgres-backed implementation — `PostgresAgentStore` (postgres-agent-store.ts).
 * This is the one place that should be reached for when a caller needs a real store; it
 * replaces the `InMemoryAgentStore` placeholder that `ports.ts` still exports (kept there
 * deliberately — the test suite depends on it, see ports.ts's header).
 *
 * NOT wired further than this file: `cloud/phase2-runtime/compose-runtime.ts` currently
 * constructs `new InMemoryAgentStore()` directly for `AgentClosedChatBridgeDeps.store`
 * (inbound-bridge.ts), and that file is outside this track's edit boundary
 * (cloud/phase2-runtime/** stays owned by Track H). Swapping that one call site to
 * `agentStoreFromEnv()` is Track H's follow-up, not a change this file can make on its own.
 */
export function agentStoreFromEnv(): AgentStore {
  return new PostgresAgentStore();
}

export type { AgentStore, SendPort };
