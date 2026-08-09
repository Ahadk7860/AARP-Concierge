// Gemini model wiring for the v3 agent path (V3_ARCHITECTURE.md §3), built on the same
// OpenAI-compatible endpoint convention as the existing `liveModelConfigFromEnv`
// (cloud/phase2-runtime/live-providers.ts) rather than reusing that function directly —
// v3 needs three separately-tunable model ids (router / agent / escalation) sharing one
// base URL and key, which the Phase 2 single-model shape can't express.
//
// "Confirm the exact Gemini model ids against the endpoint before wiring; do not trust
// the strings in §3 blindly" (V3_ARCHITECTURE.md §3). `probeModelId` below does that probe
// when a live key is configured; see its doc comment for what happens when one isn't.

export type AgentModelConfig = {
  routerModel: string;
  agentModel: string;
  escalationModel: string;
  apiKey: string;
  baseUrl: string;
};

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Reads BOI_ROUTER_MODEL / BOI_AGENT_MODEL / BOI_AGENT_ESCALATION_MODEL / BOI_LIVE_CHAT_API_KEY
 * / BOI_LIVE_CHAT_BASE_URL. Returns null (never throws) when the key or any model id is
 * missing, matching the existing `liveModelConfigFromEnv` "absent means offline" convention
 * so callers fail closed to a stub provider rather than crash at boot.
 */
export function agentModelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentModelConfig | null {
  const apiKey = env["BOI_LIVE_CHAT_API_KEY"]?.trim();
  const routerModel = env["BOI_ROUTER_MODEL"]?.trim();
  const agentModel = env["BOI_AGENT_MODEL"]?.trim();
  const escalationModel = env["BOI_AGENT_ESCALATION_MODEL"]?.trim();
  if (!apiKey || !routerModel || !agentModel || !escalationModel) return null;
  return {
    routerModel,
    agentModel,
    escalationModel,
    apiKey,
    baseUrl: env["BOI_LIVE_CHAT_BASE_URL"]?.trim() || DEFAULT_BASE_URL,
  };
}

export type ModelProbeResult = { model: string; confirmed: boolean; reason?: string };

/**
 * Best-effort confirmation that each configured model id is a model the endpoint actually
 * serves, via GET {baseUrl}/models. This is advisory, not a gate: a probe failure (network,
 * auth, an endpoint that doesn't expose /models) logs and returns `confirmed: false` rather
 * than blocking startup — the alternative is a build session trusting the §3 strings blindly,
 * which is the exact mistake this function exists to catch, not repeat under a different name.
 *
 * NOT run automatically; call it once at deploy/startup with real credentials. This
 * worktree has no live Gemini key, so the three model ids in §3
 * (gemini-2.5-flash-lite, gemini-2.5-flash-lite, gemini-2.5-pro) are wired but UNCONFIRMED
 * against the endpoint — flagged in the Track B report, not silently assumed correct.
 */
export async function probeModelIds(config: AgentModelConfig): Promise<ModelProbeResult[]> {
  const targets = [config.routerModel, config.agentModel, config.escalationModel];
  const unique = [...new Set(targets)];
  let available: Set<string> | null = null;
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = await response.json() as { data?: Array<{ id?: string }> };
      available = new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // Network/endpoint-shape failure — fall through to "unconfirmed", not a throw.
  }
  return unique.map((model) => {
    if (available === null) return { model, confirmed: false, reason: "probe_unreachable" };
    return available.has(model)
      ? { model, confirmed: true }
      : { model, confirmed: false, reason: "not_in_endpoint_model_list" };
  });
}
