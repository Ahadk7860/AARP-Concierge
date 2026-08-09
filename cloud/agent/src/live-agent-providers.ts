// Live Gemini-backed implementations of the agent loop's model seams (agent-loop.ts).
// Kept separate from agent-loop.ts itself so the loop's control flow can be tested with
// scripted providers and never needs a network call or an API key.

import { callChatCompletion, type ChatMessage } from "./gemini-client.js";
import { AGENT_TOOL_SPECS } from "./tool-specs.js";
import type { AgentModelConfig } from "./model-config.js";
import type { AgentModelProvider, EscalationProvider } from "./agent-loop.js";

/** gemini-2.5-flash-lite (§3) — the main tool-calling loop. */
export class LiveAgentModelProvider implements AgentModelProvider {
  constructor(private readonly config: AgentModelConfig) {}

  async turn(messages: ChatMessage[]): Promise<{ content: string | null; tool_calls: import("./gemini-client.js").ToolCall[] | null }> {
    return callChatCompletion({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.agentModel,
      messages,
      tools: AGENT_TOOL_SPECS,
      temperature: 0.2,
      maxTokens: 1024,
    });
  }
}

/** gemini-2.5-pro (§3) — the single verifier-rejection escalation. No tools: it is asked
 * to rewrite using only the evidence already surfaced in the transcript, not to go fetch
 * more (the regenerate contract in verifier.ts is one shot). */
export class LiveEscalationProvider implements EscalationProvider {
  constructor(private readonly config: AgentModelConfig) {}

  async regenerate(messages: ChatMessage[], _violationSummary: string): Promise<string> {
    const result = await callChatCompletion({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.escalationModel,
      messages,
      temperature: 0,
      maxTokens: 1024,
    });
    return result.content ?? "";
  }
}
