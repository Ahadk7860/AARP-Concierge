// Assembly point for the v3 agent path, built BESIDE the live cloud/phase2-runtime /
// cloud/inbound closed-vocabulary path — not wired into it. Track H integrates this behind
// a feature flag once the verifier has demonstrably held (V3_ARCHITECTURE.md §6, "the old
// closed-vocabulary path stays live until H proves the verifier holds. Do not delete it
// early."). This file does not import from, and is not imported by, cloud/phase2-runtime
// or cloud/inbound — that boundary is deliberate, not an oversight.

import { agentModelConfigFromEnv, type AgentModelConfig } from "./model-config.js";
import { LiveAgentModelProvider, LiveEscalationProvider } from "./live-agent-providers.js";
import { ModelRouterProvider, OfflineRouterProvider, type RouterProvider } from "./router.js";
import type { AgentModelProvider, EscalationProvider } from "./agent-loop.js";
import type { AgentStore } from "./ports.js";
import { DegradedDeviceSearchPort, type DeviceSearchPort } from "./ports.js";
import { NullApprovalTokenStore, type ApprovalTokenStore, type SendPort } from "./tools.js";

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
  modelConfig: AgentModelConfig | null;
};

/**
 * Builds the model-facing seams from env. When no live model key is configured, falls back
 * to the offline router baseline and throws-on-call model/escalation stand-ins — matching
 * the existing `liveModelConfigFromEnv` "absent means offline" convention (live-providers.ts)
 * rather than crashing at boot. Track H supplies `AgentStore` / `DeviceSearchPort` /
 * `ApprovalTokenStore` / `SendPort` separately per request, scoped to the caller's UserScope.
 */
export function buildAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const modelConfig = agentModelConfigFromEnv(env);
  if (modelConfig === null) {
    return {
      router: new OfflineRouterProvider(),
      agentModel: { turn: async () => ({ content: null, tool_calls: null }) },
      escalation: { regenerate: async () => "" },
      modelConfig: null,
    };
  }
  return {
    router: new ModelRouterProvider(modelConfig),
    agentModel: new LiveAgentModelProvider(modelConfig),
    escalation: new LiveEscalationProvider(modelConfig),
    modelConfig,
  };
}

/** Placeholder ports for local/dev use before Track E's tables and Track C's device link
 * are wired in for real. Never used when agentPathEnabledFromEnv() is false. */
export type UnwiredPorts = {
  deviceSearch: DeviceSearchPort;
  approvals: ApprovalTokenStore;
};

export function unwiredPorts(): UnwiredPorts {
  return { deviceSearch: new DegradedDeviceSearchPort(), approvals: new NullApprovalTokenStore() };
}

export type { AgentStore, SendPort };
