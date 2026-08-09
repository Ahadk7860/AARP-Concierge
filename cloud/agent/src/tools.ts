// The §4.2 tool registry (frozen contract). Track C implements `search_messages` against
// the same contract independently — the input/output shapes here MUST match §4.2 exactly,
// or both tracks silently drift apart.
//
// Every tool returns `evidence: Array<{ source, id }>`. The verifier is the only consumer
// that reads it; a tool that returns no evidence refs cannot support any claim (V3_ARCHITECTURE
// §4.2). `draft_message` never sends. `send_message` never fires without an explicit
// in-conversation `approval_token` (I4) — this is enforced here, not left to the caller.

import type { UserScope } from "../../db/src/scope.js";
import type { AgentStore, DeviceSearchPort } from "./ports.js";
import { DegradedDeviceSearchPort } from "./ports.js";
import type {
  CircleInput,
  CircleOutput,
  DraftMessageInput,
  DraftMessageOutput,
  DriftingInput,
  DriftingOutput,
  EvidenceRef,
  MemorySearchInput,
  MemorySearchOutput,
  MemoryWriteInput,
  MemoryWriteOutput,
  OpenLoopsInput,
  OpenLoopsOutput,
  RelationshipStateInput,
  RelationshipStateOutput,
  SearchMessagesInput,
  SearchMessagesOutput,
  SendMessageInput,
  SendMessageOutput,
  ToolResult,
} from "./types.js";

export class ToolInputError extends Error {
  constructor(tool: string, reason: string) {
    super(`tool_input_invalid:${tool}:${reason}`);
    this.name = "ToolInputError";
  }
}

/** Consumes a single-use token issued only after explicit in-conversation approval (I4). */
export interface ApprovalTokenStore {
  /** Returns the person_id the token was scoped to, or null if invalid/expired/reused. */
  consume(scope: UserScope, token: string): Promise<string | null>;
}

export class NullApprovalTokenStore implements ApprovalTokenStore {
  async consume(): Promise<string | null> {
    return null;
  }
}

/** Actually delivers a message once send_message has cleared the approval gate. */
export interface SendPort {
  send(scope: UserScope, personId: string, text: string): Promise<boolean>;
}

export class InMemorySendPort implements SendPort {
  readonly sent: Array<{ person_id: string; text: string }> = [];

  async send(_scope: UserScope, personId: string, text: string): Promise<boolean> {
    this.sent.push({ person_id: personId, text });
    return true;
  }
}

export type ToolContext = {
  scope: UserScope;
  store: AgentStore;
  deviceSearch?: DeviceSearchPort;
  approvals?: ApprovalTokenStore;
  send?: SendPort;
  now?: () => Date;
  requestId?: () => string;
};

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

function requireNonEmptyString(tool: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(tool, `${field}_required`);
  }
  return value;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SHOULD-FIX (adversarial review): §4.2's `search_messages({ when? })` is documented to
 * the model as a "time hint" (tool-specs.ts), but the tool used to hardcode
 * `when_from`/`when_to` to `undefined` and never read `input.when` at all — silently
 * accepting and discarding a parameter the model was told would work. Date-scoped search
 * has never functioned, and nothing caught it because no test exercised `when`.
 *
 * This does not attempt general natural-language date parsing (out of scope, and a false
 * "understood your hint" is worse than an honest "didn't parse it"). It parses exactly two
 * shapes: a single ISO date (`2026-08-08`, expanded to that whole day) and an ISO date
 * range (`2026-08-01..2026-08-08`, inclusive of both endpoints). Anything else returns
 * `null` and the caller surfaces that honestly via `degraded: "when_unparsed"` rather than
 * silently running the search unfiltered as if the hint had been honored.
 */
export function parseWhenHint(when: string): { when_from: string; when_to: string } | null {
  const trimmed = when.trim();
  const single = ISO_DATE_RE.exec(trimmed);
  if (single !== null) {
    return { when_from: `${trimmed}T00:00:00Z`, when_to: `${trimmed}T23:59:59Z` };
  }
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (range !== null) {
    const [, from, to] = range;
    if (from !== undefined && to !== undefined && from <= to) {
      return { when_from: `${from}T00:00:00Z`, when_to: `${to}T23:59:59Z` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// search_messages — storage-agnostic (§4.2/§4.3). Device first, honest degradation
// when the Mac is asleep or not wired; never fabricates results.
// ---------------------------------------------------------------------------

export async function searchMessages(
  ctx: ToolContext,
  input: SearchMessagesInput,
): Promise<ToolResult<SearchMessagesOutput>> {
  const query = requireNonEmptyString("search_messages", "query", input.query);
  const limit = clampLimit(input.limit, 5, 20);
  const port = ctx.deviceSearch ?? new DegradedDeviceSearchPort();
  const requestId = ctx.requestId?.() ?? `req_${Math.random().toString(36).slice(2, 10)}`;

  // See parseWhenHint's doc comment: a hint that doesn't parse runs the search unfiltered
  // by date rather than silently pretending it was honored, and says so via `degraded`.
  const whenRange = input.when !== undefined ? parseWhenHint(input.when) : null;
  const whenUnparsed = input.when !== undefined && whenRange === null;

  const response = await port.search({
    v: 1,
    id: requestId,
    op: "search",
    query,
    who: input.who,
    when_from: whenRange?.when_from,
    when_to: whenRange?.when_to,
    limit,
  });

  if (!response.ok) {
    // §4.3's three reasons are kept distinguishable end to end — the agent loop branches
    // on `asleep` specifically to offer the honest "I need your Mac awake" degradation
    // (V3_ARCHITECTURE.md §5A) rather than a generic failure.
    return {
      results: [],
      source: "cache",
      degraded: response.reason,
      evidence: [],
    };
  }

  // §4.3's wire shape has no `display` (it returns `person_id` + `score`, nothing else);
  // §4.2's contract requires one. That mapping is this tool's job, not the device search
  // port's. Batched (one relationshipStateBatch call, not one relationshipState call per
  // row) — this is the hot path, every search hits it, and the N+1 was flagged in review.
  const personIds = [...new Set(response.results.map((row) => row.person_id))];
  const states = await ctx.store.relationshipStateBatch(ctx.scope, personIds);
  const results = response.results.map((row) => ({
    person_id: row.person_id,
    display: states.get(row.person_id)?.display ?? row.person_id,
    when: row.when,
    snippet: row.snippet,
    thread_id: row.thread_id,
  }));

  return {
    results,
    source: "device",
    // whenUnparsed is reported even on an otherwise-successful search: the query ran, but
    // not scoped the way the caller asked, which the caller needs to know to trust (or
    // not) that an empty/broad result set reflects the date range they meant.
    degraded: whenUnparsed ? "when_unparsed" : undefined,
    evidence: results.map((row): EvidenceRef => ({ source: "message", id: `${row.thread_id}:${row.when}` })),
  };
}

// ---------------------------------------------------------------------------
// relationship_state
// ---------------------------------------------------------------------------

export async function relationshipState(
  ctx: ToolContext,
  input: RelationshipStateInput,
): Promise<ToolResult<RelationshipStateOutput | { person_id: null }>> {
  if (input.person_id === undefined && input.display === undefined) {
    throw new ToolInputError("relationship_state", "person_id_or_display_required");
  }
  const row = await ctx.store.relationshipState(ctx.scope, input);
  if (row === null) {
    return { person_id: null, evidence: [] };
  }
  return { ...row, evidence: [{ source: "relationship", id: row.person_id }] };
}

// ---------------------------------------------------------------------------
// open_loops
// ---------------------------------------------------------------------------

export async function openLoops(
  ctx: ToolContext,
  input: OpenLoopsInput,
): Promise<ToolResult<OpenLoopsOutput>> {
  const limit = clampLimit(input.limit, 10, 50);
  const loops = await ctx.store.openLoops(ctx.scope, {
    direction: input.direction,
    kind: input.kind,
    limit,
  });
  return {
    loops,
    evidence: loops.map((loop): EvidenceRef => ({ source: "open_loop", id: loop.loop_id })),
  };
}

// ---------------------------------------------------------------------------
// drifting
// ---------------------------------------------------------------------------

export async function drifting(
  ctx: ToolContext,
  input: DriftingInput,
): Promise<ToolResult<DriftingOutput>> {
  const limit = clampLimit(input.limit, 10, 50);
  const relationships = await ctx.store.drifting(ctx.scope, { limit });
  return {
    relationships,
    evidence: relationships.map((row): EvidenceRef => ({ source: "relationship", id: row.person_id })),
  };
}

// ---------------------------------------------------------------------------
// circle
// ---------------------------------------------------------------------------

export async function circle(
  ctx: ToolContext,
  input: CircleInput,
): Promise<ToolResult<CircleOutput>> {
  const personId = requireNonEmptyString("circle", "person_id", input.person_id);
  const connections = await ctx.store.circle(ctx.scope, personId);
  return {
    connections,
    evidence: connections.map((row): EvidenceRef => ({ source: "relationship_edge", id: row.person_id })),
  };
}

// ---------------------------------------------------------------------------
// memory_write / memory_search
// ---------------------------------------------------------------------------

export async function memoryWrite(
  ctx: ToolContext,
  input: MemoryWriteInput,
): Promise<ToolResult<MemoryWriteOutput>> {
  const text = requireNonEmptyString("memory_write", "text", input.text);
  const result = await ctx.store.memoryWrite(ctx.scope, { text, person_id: input.person_id });
  return { ...result, evidence: [{ source: "memory", id: result.memory_id }] };
}

export async function memorySearch(
  ctx: ToolContext,
  input: MemorySearchInput,
): Promise<ToolResult<MemorySearchOutput>> {
  const query = requireNonEmptyString("memory_search", "query", input.query);
  const memories = await ctx.store.memorySearch(ctx.scope, query);
  return {
    memories,
    evidence: memories.map((row): EvidenceRef => ({ source: "memory", id: row.memory_id })),
  };
}

// ---------------------------------------------------------------------------
// draft_message — composes, never sends.
// ---------------------------------------------------------------------------

export async function draftMessage(
  ctx: ToolContext,
  input: DraftMessageInput,
): Promise<ToolResult<DraftMessageOutput>> {
  const personId = requireNonEmptyString("draft_message", "person_id", input.person_id);
  const intent = requireNonEmptyString("draft_message", "intent", input.intent);

  const state = await ctx.store.relationshipState(ctx.scope, { person_id: personId });
  const openLoopRows = await ctx.store.openLoops(ctx.scope, { limit: 50 });
  const relevantLoop = openLoopRows.find((loop) => loop.person_id === personId);

  const basedOn: EvidenceRef[] = [];
  if (state !== null) basedOn.push({ source: "relationship", id: state.person_id });
  if (relevantLoop !== undefined) basedOn.push({ source: "open_loop", id: relevantLoop.loop_id });

  if (basedOn.length === 0) {
    // No grounding evidence for this person. Compose nothing rather than invent a draft
    // the verifier could never clear.
    return { draft: "", based_on: [], evidence: [] };
  }

  const display = state?.display ?? personId;
  const draft = relevantLoop !== undefined
    ? `Hey ${display} — following up on: ${relevantLoop.description}`
    : `Hey ${display} — ${intent}`;

  return { draft, based_on: basedOn, evidence: basedOn };
}

// ---------------------------------------------------------------------------
// send_message — REQUIRES approval_token (I4). Never fires without one.
// ---------------------------------------------------------------------------

export async function sendMessage(
  ctx: ToolContext,
  input: SendMessageInput,
): Promise<ToolResult<SendMessageOutput>> {
  const personId = requireNonEmptyString("send_message", "person_id", input.person_id);
  requireNonEmptyString("send_message", "text", input.text);
  const token = requireNonEmptyString("send_message", "approval_token", input.approval_token);

  const approvals = ctx.approvals ?? new NullApprovalTokenStore();
  const approvedPersonId = await approvals.consume(ctx.scope, token);
  if (approvedPersonId === null || approvedPersonId !== personId) {
    // I4: never fires without an explicit, matching, in-conversation approval token.
    return { sent: false, evidence: [] };
  }

  const sendPort = ctx.send;
  if (sendPort === undefined) return { sent: false, evidence: [] };
  const sent = await sendPort.send(ctx.scope, personId, input.text);
  return { sent, evidence: sent ? [{ source: "send", id: personId }] : [] };
}

// ---------------------------------------------------------------------------
// Registry — the surface the agent loop dispatches against.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "search_messages",
  "relationship_state",
  "open_loops",
  "drifting",
  "circle",
  "memory_write",
  "memory_search",
  "draft_message",
  "send_message",
] as const;

export type ToolName = typeof TOOL_NAMES[number];

export type ToolRegistry = {
  search_messages: typeof searchMessages;
  relationship_state: typeof relationshipState;
  open_loops: typeof openLoops;
  drifting: typeof drifting;
  circle: typeof circle;
  memory_write: typeof memoryWrite;
  memory_search: typeof memorySearch;
  draft_message: typeof draftMessage;
  send_message: typeof sendMessage;
};

export const TOOL_REGISTRY: ToolRegistry = {
  search_messages: searchMessages,
  relationship_state: relationshipState,
  open_loops: openLoops,
  drifting,
  circle,
  memory_write: memoryWrite,
  memory_search: memorySearch,
  draft_message: draftMessage,
  send_message: sendMessage,
};

/** Dispatches by name with an untyped input — the shape the agent loop's model calls into. */
export async function invokeTool(
  ctx: ToolContext,
  name: ToolName,
  input: unknown,
): Promise<ToolResult<Record<string, unknown>>> {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "search_messages": return searchMessages(ctx, record as unknown as SearchMessagesInput);
    case "relationship_state": return relationshipState(ctx, record as unknown as RelationshipStateInput);
    case "open_loops": return openLoops(ctx, record as unknown as OpenLoopsInput);
    case "drifting": return drifting(ctx, record as unknown as DriftingInput);
    case "circle": return circle(ctx, record as unknown as CircleInput);
    case "memory_write": return memoryWrite(ctx, record as unknown as MemoryWriteInput);
    case "memory_search": return memorySearch(ctx, record as unknown as MemorySearchInput);
    case "draft_message": return draftMessage(ctx, record as unknown as DraftMessageInput);
    case "send_message": return sendMessage(ctx, record as unknown as SendMessageInput);
    default: {
      const exhaustive: never = name;
      throw new ToolInputError(String(exhaustive), "unknown_tool");
    }
  }
}
