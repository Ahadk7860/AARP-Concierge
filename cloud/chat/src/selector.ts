import type { ChatQuery } from "../../shared/src/contracts.js";

export type ChatToolDescription = {
  name: "waiting_on_me";
  description: string;
  limit: { minimum: 1; maximum: 3 };
};

const WAITING_ON_ME_TOOL = Object.freeze<ChatToolDescription>({
  name: "waiting_on_me",
  description: "List up to three relationships where the other person asked a question and an open thread remained at the last sync.",
  limit: Object.freeze({ minimum: 1, maximum: 3 }),
});

/** The entire vocabulary visible to a selector provider in Phase 2. */
export const CHAT_TOOL_VOCABULARY: readonly ChatToolDescription[] = Object.freeze([
  WAITING_ON_ME_TOOL,
]);

export type SelectorProviderInput = {
  question: string;
  tools: readonly ChatToolDescription[];
};

/**
 * A selector provider receives no digest, schema, relationship, or evidence row. A live
 * provider may implement this interface later; Phase 2 evaluation uses recorded output.
 */
export interface ChatSelectorProvider {
  select(input: SelectorProviderInput): Promise<unknown>;
}

export type ClosedChatSelection =
  | { kind: "query"; query: ChatQuery }
  | { kind: "decline"; reason: "provider_declined" | "invalid_provider_output" | "empty_question" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** Parse only the literal provider protocol; SQL/free-form/unknown tools have no path. */
export function parseSelectorOutput(value: unknown): ClosedChatSelection {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "decline", reason: "invalid_provider_output" };
  }
  if (value.kind === "decline" && exactKeys(value, ["kind"])) {
    return { kind: "decline", reason: "provider_declined" };
  }
  if (
    value.kind === "query"
    && exactKeys(value, ["kind", "name", "limit"])
    && value.name === "waiting_on_me"
    && typeof value.limit === "number"
    && Number.isInteger(value.limit)
    && value.limit >= 1
    && value.limit <= 3
  ) {
    return {
      kind: "query",
      query: { schema_version: "chat_query.v1", name: "waiting_on_me", limit: value.limit },
    };
  }
  return { kind: "decline", reason: "invalid_provider_output" };
}

export async function selectClosedChatQuery(
  question: string,
  provider: ChatSelectorProvider,
): Promise<ClosedChatSelection> {
  if (question.trim() === "") return { kind: "decline", reason: "empty_question" };

  let output: unknown;
  try {
    // Deliberately construct the value here. There is no optional context bag through
    // which a caller could accidentally forward the digest or query evidence.
    output = await provider.select({ question, tools: CHAT_TOOL_VOCABULARY });
  } catch {
    return { kind: "decline", reason: "invalid_provider_output" };
  }
  return parseSelectorOutput(output);
}

/** A deterministic fake boundary for tests and the recorded 50-question evaluation. */
export class RecordedSelectorProvider implements ChatSelectorProvider {
  readonly calls: SelectorProviderInput[] = [];

  constructor(private readonly outputs: ReadonlyMap<string, unknown>) {}

  async select(input: SelectorProviderInput): Promise<unknown> {
    this.calls.push(input);
    return this.outputs.get(input.question) ?? { kind: "decline" };
  }
}

/**
 * A deliberately small semantic baseline for offline safety evaluation. It is not a
 * production model and its green result is not a shipping decision. Recognition is
 * phrasing-based and only returns the single closed tool or decline.
 */
export class OfflineSemanticSelectorProvider implements ChatSelectorProvider {
  readonly calls: SelectorProviderInput[] = [];

  async select(input: SelectorProviderInput): Promise<unknown> {
    this.calls.push(input);
    const question = input.question.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
    const unsafeInstruction = /\b(?:ignore|system|dump|schema|tool|limit|reveal|directly)\b/.test(question);
    if (unsafeInstruction) return { kind: "decline" };
    const waitingIntent = [
      /\bwho should i follow up with\b/,
      /\bwho is waiting on me\b/,
      /\b(?:ask|asked) me something\b/,
      /\bquestions? (?:have|did) i (?:left|leave) open\b/,
      /\bowe (?:a|someone|anyone) repl(?:y|ies)\b/,
      /\bunanswered questions? for me\b/,
      /\bball in my court\b/,
      /\bquestion i missed\b/,
      /\bconversations? need my response\b/,
      /\bleaving (?:(?:someone|anyone) )?hanging on a question\b/,
      /\bopen replies\b/,
      /\bwaiting for an answer from me\b/,
      /\bquestion should i answer next\b/,
      /\bpeople i should answer\b/,
    ].some((pattern) => pattern.test(question));

    if (!waitingIntent) return { kind: "decline" };
    const limit = /\b(?:one|next)\b/.test(question) ? 1 : /\btwo\b/.test(question) ? 2 : 3;
    return { kind: "query", name: "waiting_on_me", limit };
  }
}
