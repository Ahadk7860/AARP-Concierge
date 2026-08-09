// Ports the tool registry (tools.ts) is built against. §4.1's persons/interactions/
// open_loops/etc. tables (owner: Track E) do not exist in this worktree yet, so the tool
// registry is written against these interfaces rather than SQL directly — "storage-agnostic
// by design" per §4.2. A Postgres-backed implementation slots in behind `AgentStore` once
// Track E's migrations land; nothing in tools.ts, the agent loop, or the verifier changes.
//
// Everything here keys on `person_id`, never `contact_id` (§4.1).

import type { UserScope } from "../../db/src/scope.js";
import type {
  CircleConnectionRow,
  DriftingRow,
  MemoryRow,
  OpenLoopRow,
  RelationshipStateInput,
  RelationshipStateOutput,
} from "./types.js";

export interface AgentStore {
  relationshipState(
    scope: UserScope,
    input: RelationshipStateInput,
  ): Promise<RelationshipStateOutput | null>;

  openLoops(
    scope: UserScope,
    input: { direction?: "i_owe_them" | "they_owe_me"; kind?: string; limit: number },
  ): Promise<OpenLoopRow[]>;

  drifting(scope: UserScope, input: { limit: number }): Promise<DriftingRow[]>;

  circle(scope: UserScope, personId: string): Promise<CircleConnectionRow[]>;

  memoryWrite(
    scope: UserScope,
    input: { text: string; person_id?: string },
  ): Promise<{ memory_id: string }>;

  memorySearch(scope: UserScope, query: string): Promise<MemoryRow[]>;

  /** Resolves a display or handle to person_id, for tools whose input isn't already keyed. */
  resolvePerson(scope: UserScope, display: string): Promise<{ person_id: string; display: string } | null>;
}

// ---------------------------------------------------------------------------
// ask_device protocol (§4.3, owner: Track C). B is the consumer: the search_messages
// tool calls this port; Track C implements it against the real WebSocket relay. Until
// wired, DegradedDeviceSearchPort below answers honestly rather than fabricating results.
// ---------------------------------------------------------------------------

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

export type AskDeviceSearchResponse =
  | {
    v: 1;
    id: string;
    ok: true;
    results: Array<{ person_id: string; when: string; snippet: string; thread_id: string; score: number }>;
  }
  | { v: 1; id: string; ok: false; reason: "asleep" | "timeout" | "no_grant" };

export interface DeviceSearchPort {
  search(request: AskDeviceSearchRequest): Promise<AskDeviceSearchResponse>;
}

/**
 * Honest fallback when Track C's device link isn't wired into this call path yet.
 * Never fabricates results — returns an empty, explicitly degraded response so
 * search_messages can report `source: "cache"` with a `degraded` reason instead of
 * silently pretending the device answered.
 */
export class DegradedDeviceSearchPort implements DeviceSearchPort {
  async search(request: AskDeviceSearchRequest): Promise<AskDeviceSearchResponse> {
    return { v: 1, id: request.id, ok: false, reason: "no_grant" };
  }
}

// ---------------------------------------------------------------------------
// In-memory fakes — for tests and for developing the agent loop before Track E lands.
// ---------------------------------------------------------------------------

export class InMemoryAgentStore implements AgentStore {
  private readonly relationships = new Map<string, RelationshipStateOutput>();
  private readonly loops: OpenLoopRow[] = [];
  private readonly driftingRows: DriftingRow[] = [];
  private readonly connections = new Map<string, CircleConnectionRow[]>();
  private readonly memories: MemoryRow[] = [];
  private memorySeq = 0;

  seedRelationship(row: RelationshipStateOutput): void {
    this.relationships.set(row.person_id, row);
  }

  seedLoop(row: OpenLoopRow): void {
    this.loops.push(row);
  }

  seedDrifting(row: DriftingRow): void {
    this.driftingRows.push(row);
  }

  seedCircle(personId: string, rows: CircleConnectionRow[]): void {
    this.connections.set(personId, rows);
  }

  async relationshipState(
    _scope: UserScope,
    input: RelationshipStateInput,
  ): Promise<RelationshipStateOutput | null> {
    if (input.person_id !== undefined) return this.relationships.get(input.person_id) ?? null;
    if (input.display !== undefined) {
      const matches = [...this.relationships.values()].filter((row) => row.display === input.display);
      return matches.length === 1 ? matches[0]! : null;
    }
    return null;
  }

  async openLoops(
    _scope: UserScope,
    input: { direction?: "i_owe_them" | "they_owe_me"; kind?: string; limit: number },
  ): Promise<OpenLoopRow[]> {
    return this.loops
      .filter((row) => input.direction === undefined || row.direction === input.direction)
      .filter((row) => input.kind === undefined || row.kind === input.kind)
      .slice(0, input.limit);
  }

  async drifting(_scope: UserScope, input: { limit: number }): Promise<DriftingRow[]> {
    return this.driftingRows.slice(0, input.limit);
  }

  async circle(_scope: UserScope, personId: string): Promise<CircleConnectionRow[]> {
    return this.connections.get(personId) ?? [];
  }

  async memoryWrite(
    _scope: UserScope,
    input: { text: string; person_id?: string },
  ): Promise<{ memory_id: string }> {
    this.memorySeq += 1;
    const memory_id = `mem_${this.memorySeq}`;
    this.memories.push({ memory_id, person_id: input.person_id ?? null, text: input.text });
    return { memory_id };
  }

  async memorySearch(_scope: UserScope, query: string): Promise<MemoryRow[]> {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.memories.filter((row) => row.text.toLowerCase().includes(needle));
  }

  async resolvePerson(
    _scope: UserScope,
    display: string,
  ): Promise<{ person_id: string; display: string } | null> {
    const matches = [...this.relationships.values()].filter((row) => row.display === display);
    if (matches.length !== 1) return null;
    return { person_id: matches[0]!.person_id, display: matches[0]!.display };
  }
}
