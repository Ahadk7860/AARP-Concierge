// The `ask_device` wire protocol — V3_ARCHITECTURE.md §4.3, FROZEN.
//
// Cloud -> Mac over the persistent WebSocket:
//
//   request:  { v: 1, id, op: "search", query, who?, when_from?, when_to?, limit }
//   response: { v: 1, id, ok: true, results: [{ person_id, when, snippet, thread_id, score }] }
//          or { v: 1, id, ok: false, reason: "asleep"|"timeout"|"no_grant" }
//
// **Note the shape difference from §4.2's `search_messages` tool output, on purpose**:
// this wire response row is `{ person_id, when, snippet, thread_id, score }` — `score`,
// no `display`. Track B's agent (cloud/agent/src/tools.ts, a different worktree) maps
// each row to the §4.2 shape by looking `person_id` up against the relationship store.
// This module never adds `display` and never drops `score`.
//
// Defined independently here (not imported from cloud/agent/src/ports.ts) because
// cloud/agent doesn't exist in this worktree — Track B builds it in parallel in its own
// worktree. TypeScript's structural typing means anything satisfying `DeviceSearchPort`
// below is assignable to Track B's identically-shaped interface once the two branches
// merge; keep both in sync with V3_ARCHITECTURE.md §4.3 itself if it ever changes.

export type AskDeviceSearchRequest = {
  v: 1;
  id: string;
  op: "search";
  query: string;
  who?: string;
  when_from?: string;
  when_to?: string;
  limit: number;
};

export type AskDeviceSearchResultRow = {
  person_id: string;
  when: string;
  snippet: string;
  thread_id: string;
  score: number;
};

export type AskDeviceFailureReason = "asleep" | "timeout" | "no_grant";

export type AskDeviceSearchResponse =
  | { v: 1; id: string; ok: true; results: AskDeviceSearchResultRow[] }
  | { v: 1; id: string; ok: false; reason: AskDeviceFailureReason };

/** What Track B's `ToolContext.deviceSearch` (cloud/agent/src/tools.ts) expects. */
export interface DeviceSearchPort {
  search(request: AskDeviceSearchRequest): Promise<AskDeviceSearchResponse>;
}

/** Type guard for a raw parsed JSON value arriving off the wire from a Mac. */
export function isAskDeviceSearchResponse(value: unknown): value is AskDeviceSearchResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["v"] !== 1) return false;
  if (typeof record["id"] !== "string") return false;
  if (record["ok"] === true) {
    return Array.isArray(record["results"]);
  }
  if (record["ok"] === false) {
    return (
      record["reason"] === "asleep" ||
      record["reason"] === "timeout" ||
      record["reason"] === "no_grant"
    );
  }
  return false;
}
