// Shared types for the v3 agent core (Track B).
//
// Every tool in the §4.2 registry returns its documented data shape PLUS an
// `evidence` array of `{ source, id }` refs (V3_ARCHITECTURE.md §4.2: "Every tool
// returns an evidence array ... A tool that returns no evidence refs cannot support
// any claim."). The verifier (verifier.ts) is the only consumer that reads `evidence`;
// callers of individual tools use the rest of the shape exactly as documented.

export type EvidenceRef = { source: string; id: string };

/** Wraps any tool's documented return shape with the universal evidence array. */
export type ToolResult<T> = T & { evidence: EvidenceRef[] };

export type Lifecycle = "new" | "building" | "steady" | "cooling" | "dormant" | "rekindled";

// ---------------------------------------------------------------------------
// §4.2 tool payload shapes (data only — evidence is added by ToolResult<T>)
// ---------------------------------------------------------------------------

export type SearchMessagesInput = {
  query: string;
  who?: string;
  when?: string;
  limit?: number;
};

export type SearchMessagesResultRow = {
  person_id: string;
  display: string;
  when: string;
  snippet: string;
  thread_id: string;
};

export type SearchMessagesOutput = {
  results: SearchMessagesResultRow[];
  source: "device" | "cache";
  degraded?: string;
};

export type RelationshipStateInput = {
  person_id?: string;
  display?: string;
};

export type RelationshipStateOutput = {
  person_id: string;
  display: string;
  lifecycle_stage: Lifecycle | null;
  expected_gap_days: number | null;
  overdue_by_days: number | null;
  momentum: number | null;
  initiation_ratio: number | null;
  register: string | null;
  relationship_kind: string | null;
  last_contact: string;
};

export type OpenLoopsInput = {
  direction?: "i_owe_them" | "they_owe_me";
  kind?: string;
  limit?: number;
};

export type OpenLoopRow = {
  loop_id: string;
  person_id: string;
  display: string;
  kind: string;
  direction: "i_owe_them" | "they_owe_me";
  description: string;
  age_days: number;
};

export type OpenLoopsOutput = { loops: OpenLoopRow[] };

export type DriftingInput = { limit?: number };

export type DriftingRow = {
  person_id: string;
  display: string;
  overdue_by_days: number;
  expected_gap_days: number;
};

export type DriftingOutput = { relationships: DriftingRow[] };

export type CircleInput = { person_id: string };

export type CircleConnectionRow = {
  person_id: string;
  display: string;
  shared_groups: number;
  tie_strength: number | null;
};

export type CircleOutput = { connections: CircleConnectionRow[] };

export type MemoryWriteInput = { text: string; person_id?: string };
export type MemoryWriteOutput = { memory_id: string };

export type MemorySearchInput = { query: string };
export type MemoryRow = { memory_id: string; person_id: string | null; text: string };
export type MemorySearchOutput = { memories: MemoryRow[] };

export type DraftMessageInput = { person_id: string; intent: string };
export type DraftMessageOutput = { draft: string; based_on: EvidenceRef[] };

export type SendMessageInput = { person_id: string; text: string; approval_token: string };
export type SendMessageOutput = { sent: boolean };
