// Live Gemini-backed implementations of the agent loop's model seams (agent-loop.ts).
// Kept separate from agent-loop.ts itself so the loop's control flow can be tested with
// scripted providers and never needs a network call or an API key.

import { callChatCompletion, type ChatMessage } from "./gemini-client.js";
import { AGENT_TOOL_SPECS } from "./tool-specs.js";
import type { AgentModelConfig } from "./model-config.js";
import type { AgentModelProvider, EscalationProvider } from "./agent-loop.js";
import type { GeneralKnowledgeProvider } from "./tools.js";

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

// System prompt for the `general` tool's own model call (tools.ts's `general`, wired via
// this provider) — this is a SEPARATE, isolated call, not the main tool-calling loop, and
// intentionally sees only the query, never relationship data. Its whole job is to be honest
// about the one thing this repo cannot do: fetch anything live.
const GENERAL_KNOWLEDGE_SYSTEM_PROMPT = `Answer the user's question using only your own training knowledge. You have no access to the live web, real-time data, or today's date-specific facts (current weather, live scores, current prices, breaking news). If the question needs any of that, say plainly that you can only offer a knowledge-based answer and that it may be stale or wrong — never present it as current or verified. Keep the answer concise and conversational. Do not discuss any specific person from the asker's personal life — you were not given any of that data and must not guess at it.`;

/** gemini-2.5-flash-lite (§3's `BOI_AGENT_MODEL`, same model config as the main loop — the
 * task explicitly reuses `agentModel` rather than adding a fourth tunable model id) backing
 * the `general` tool (tools.ts). A separate, single-turn call — no tools, no relationship
 * context — so this can never see or leak person data into what is meant to be pure model
 * knowledge. */
export class LiveGeneralKnowledgeProvider implements GeneralKnowledgeProvider {
  constructor(private readonly config: AgentModelConfig) {}

  async answer(query: string): Promise<string> {
    const result = await callChatCompletion({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.agentModel,
      messages: [
        { role: "system", content: GENERAL_KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      temperature: 0.2,
      maxTokens: 512,
    });
    return result.content ?? "";
  }
}
