// Thin OpenAI-compatible chat-completions client shared by the router and the agent
// loop. Same shape as cloud/phase2-runtime/live-providers.ts's `modelCall`, extended with
// optional `tools` (function calling) for the agent loop's tool-calling turns.

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatCompletionResult = {
  content: string | null;
  tool_calls: ToolCall[] | null;
};

export class GeminiCallError extends Error {}

export async function callChatCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0,
    max_tokens: input.maxTokens ?? 1024,
  };
  if (input.tools !== undefined) body["tools"] = input.tools;
  if (input.responseSchema !== undefined) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema: input.responseSchema },
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });

  if (!response.ok) throw new GeminiCallError(`model_call_failed: ${response.status}`);
  const parsed = await response.json() as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  };
  const message = parsed.choices?.[0]?.message;
  if (message === undefined) throw new GeminiCallError("model_call_empty_response");
  return { content: message.content ?? null, tool_calls: message.tool_calls ?? null };
}
