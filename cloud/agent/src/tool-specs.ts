// JSON-schema function-calling specs for the §4.2 tool registry — the shape the model
// sees, kept separate from tools.ts's TS types so a schema tweak can't silently drift the
// runtime contract (tools.ts is what actually validates/executes).

import type { ToolSpec } from "./gemini-client.js";

export const AGENT_TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description: "Full-text search over the user's own message history. Returns snippets with person_id, when, and thread_id.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          who: { type: "string", description: "Optional person_id or display name filter" },
          // SHOULD-FIX (adversarial review): this used to advertise "natural-language time
          // hint" while the tool silently ignored the field entirely. Advertise only what
          // parseWhenHint (tools.ts) actually parses — an unparseable value still runs the
          // search (unfiltered by date) and reports `degraded: "when_unparsed"` rather than
          // erroring, but the model should not expect free-form phrasing to work.
          when: {
            type: "string",
            description: "Optional date filter. Only two shapes are understood: a single ISO date (\"2026-08-08\", the whole day) or an inclusive ISO date range (\"2026-08-01..2026-08-08\"). Anything else is not parsed.",
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "relationship_state",
      description: "Look up computed relationship metrics for one person, by person_id or display name.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string" },
          display: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_loops",
      description: "List open questions, promises, plans, or favors the user owes or is owed.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["i_owe_them", "they_owe_me"] },
          kind: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drifting",
      description: "List relationships that have gone past their expected contact gap.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "circle",
      description: "List a person's shared-group connections and tie strength to other people.",
      parameters: {
        type: "object",
        properties: { person_id: { type: "string" } },
        required: ["person_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Record a user-stated or user-corrected fact for later recall.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          person_id: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search previously recorded user-stated facts.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_message",
      description: "Compose (never send) a message to a person based on their open loop / relationship state.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string" },
          intent: { type: "string" },
        },
        required: ["person_id", "intent"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message to a person. REQUIRES an approval_token obtained from explicit in-conversation user approval — never call this without one the user actually gave this turn.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string" },
          text: { type: "string" },
          approval_token: { type: "string" },
        },
        required: ["person_id", "text", "approval_token"],
        additionalProperties: false,
      },
    },
  },
];
