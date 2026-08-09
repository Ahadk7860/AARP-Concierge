import { describe, expect, it } from "vitest";
import { unsafeScopeFromUserId } from "../../db/src/scope.js";
import { InMemoryAgentStore, DegradedDeviceSearchPort, type AskDeviceSearchResponse } from "../src/ports.js";
import {
  circle,
  draftMessage,
  drifting,
  memorySearch,
  memoryWrite,
  openLoops,
  parseWhenHint,
  relationshipState,
  searchMessages,
  sendMessage,
  ToolInputError,
  type ApprovalTokenStore,
  type SendPort,
  type ToolContext,
} from "../src/tools.js";

const scope = unsafeScopeFromUserId("usr_demo00000001");

function makeStore(): InMemoryAgentStore {
  const store = new InMemoryAgentStore();
  store.seedRelationship({
    person_id: "p_maya01",
    display: "Maya",
    lifecycle_stage: "steady",
    expected_gap_days: 3,
    overdue_by_days: 1,
    momentum: 0.7,
    initiation_ratio: 0.4,
    register: "warm",
    relationship_kind: "close_friend",
    last_contact: "2026-08-05T10:00:00Z",
  });
  store.seedLoop({
    loop_id: "loop_1",
    person_id: "p_maya01",
    display: "Maya",
    kind: "question",
    direction: "i_owe_them",
    description: "asked whether you're coming to the trip",
    age_days: 4,
  });
  store.seedDrifting({
    person_id: "p_maya01",
    display: "Maya",
    overdue_by_days: 1,
    expected_gap_days: 3,
  });
  store.seedCircle("p_maya01", [{ person_id: "p_noah02", display: "Noah", shared_groups: 2, tie_strength: 0.6 }]);
  return store;
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { scope, store: makeStore(), ...overrides };
}

describe("relationship_state", () => {
  it("returns the row and one evidence ref keyed on person_id", async () => {
    const result = await relationshipState(ctx(), { person_id: "p_maya01" });
    expect(result.evidence).toEqual([{ source: "relationship", id: "p_maya01" }]);
    expect(result).toMatchObject({ display: "Maya", lifecycle_stage: "steady" });
  });

  it("returns empty evidence and null person_id when nothing matches — never fabricates a row", async () => {
    const result = await relationshipState(ctx(), { person_id: "p_unknown" });
    expect(result).toEqual({ person_id: null, evidence: [] });
  });

  it("throws on missing input rather than silently defaulting", async () => {
    await expect(relationshipState(ctx(), {})).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("open_loops / drifting / circle — evidence refs match the returned rows", () => {
  it("open_loops evidence refs are the loop_ids returned", async () => {
    const result = await openLoops(ctx(), {});
    expect(result.loops).toHaveLength(1);
    expect(result.evidence).toEqual([{ source: "open_loop", id: "loop_1" }]);
  });

  it("drifting evidence refs are the person_ids returned", async () => {
    const result = await drifting(ctx(), {});
    expect(result.evidence).toEqual([{ source: "relationship", id: "p_maya01" }]);
  });

  it("circle evidence refs are the connected person_ids", async () => {
    const result = await circle(ctx(), { person_id: "p_maya01" });
    expect(result.connections).toHaveLength(1);
    expect(result.evidence).toEqual([{ source: "relationship_edge", id: "p_noah02" }]);
  });
});

describe("memory_write / memory_search", () => {
  it("round-trips a written memory through search", async () => {
    const context = ctx();
    const written = await memoryWrite(context, { text: "Maya is allergic to shellfish" });
    expect(written.evidence).toEqual([{ source: "memory", id: written.memory_id }]);

    const found = await memorySearch(context, { query: "shellfish" });
    expect(found.memories).toHaveLength(1);
    expect(found.evidence).toEqual([{ source: "memory", id: written.memory_id }]);
  });
});

describe("draft_message — composes, never sends", () => {
  it("grounds the draft in the person's open loop when one exists", async () => {
    const result = await draftMessage(ctx(), { person_id: "p_maya01", intent: "follow up" });
    expect(result.draft).toContain("Maya");
    expect(result.based_on.some((ref) => ref.source === "open_loop")).toBe(true);
  });

  it("returns an empty draft rather than inventing one for an unknown person", async () => {
    const result = await draftMessage(ctx(), { person_id: "p_ghost", intent: "follow up" });
    expect(result.draft).toBe("");
    expect(result.based_on).toEqual([]);
    expect(result.evidence).toEqual([]);
  });
});

describe("send_message — I4: never fires without a matching approval_token", () => {
  const approvingStore: ApprovalTokenStore = {
    async consume(_scope, token) {
      return token === "tok_good" ? "p_maya01" : null;
    },
  };

  it("does not send when no approvals port is configured", async () => {
    const result = await sendMessage(ctx(), { person_id: "p_maya01", text: "hi", approval_token: "tok_good" });
    expect(result).toEqual({ sent: false, evidence: [] });
  });

  it("does not send when the token is invalid", async () => {
    const send: SendPort = { send: async () => true };
    const result = await sendMessage(ctx({ approvals: approvingStore, send }), {
      person_id: "p_maya01",
      text: "hi",
      approval_token: "tok_bad",
    });
    expect(result).toEqual({ sent: false, evidence: [] });
  });

  it("does not send when the token is valid for a DIFFERENT person than requested", async () => {
    const send: SendPort = { send: async () => true };
    const result = await sendMessage(ctx({ approvals: approvingStore, send }), {
      person_id: "p_noah02",
      text: "hi",
      approval_token: "tok_good",
    });
    expect(result).toEqual({ sent: false, evidence: [] });
  });

  it("sends only with a valid, matching token and a wired send port", async () => {
    const send: SendPort = { send: async () => true };
    const result = await sendMessage(ctx({ approvals: approvingStore, send }), {
      person_id: "p_maya01",
      text: "hi",
      approval_token: "tok_good",
    });
    expect(result.sent).toBe(true);
    expect(result.evidence).toEqual([{ source: "send", id: "p_maya01" }]);
  });

  it("throws on a missing approval_token rather than treating it as optional", async () => {
    await expect(sendMessage(ctx(), { person_id: "p_maya01", text: "hi", approval_token: "" }))
      .rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("search_messages — §4.2/§4.3 mapping and honest degradation", () => {
  it("degrades honestly with a distinguishable reason when the device port has no grant", async () => {
    const result = await searchMessages(ctx({ deviceSearch: new DegradedDeviceSearchPort() }), { query: "trip" });
    expect(result).toEqual({ results: [], source: "cache", degraded: "no_grant", evidence: [] });
  });

  it("preserves the asleep/timeout/no_grant distinction end to end", async () => {
    for (const reason of ["asleep", "timeout", "no_grant"] as const) {
      const port = { search: async (): Promise<AskDeviceSearchResponse> => ({ v: 1, id: "r1", ok: false, reason }) };
      const result = await searchMessages(ctx({ deviceSearch: port }), { query: "trip" });
      expect(result.degraded).toBe(reason);
    }
  });

  it("maps §4.3 rows (person_id, score) onto §4.2's shape, resolving display via the store", async () => {
    const port = {
      search: async (): Promise<AskDeviceSearchResponse> => ({
        v: 1,
        id: "r1",
        ok: true,
        results: [{ person_id: "p_maya01", when: "2026-08-05T10:00:00Z", snippet: "let's go on the trip", thread_id: "t1", score: 0.9 }],
      }),
    };
    const result = await searchMessages(ctx({ deviceSearch: port }), { query: "trip" });
    expect(result.results).toEqual([{
      person_id: "p_maya01",
      display: "Maya",
      when: "2026-08-05T10:00:00Z",
      snippet: "let's go on the trip",
      thread_id: "t1",
    }]);
    expect(result.evidence).toEqual([{ source: "message", id: "t1:2026-08-05T10:00:00Z" }]);
  });

  it("falls back to the raw person_id as display when the store has no relationship row for it", async () => {
    const port = {
      search: async (): Promise<AskDeviceSearchResponse> => ({
        v: 1,
        id: "r1",
        ok: true,
        results: [{ person_id: "p_unknown", when: "2026-08-05T10:00:00Z", snippet: "hi", thread_id: "t2", score: 0.5 }],
      }),
    };
    const result = await searchMessages(ctx({ deviceSearch: port }), { query: "hi" });
    expect(result.results[0]!.display).toBe("p_unknown");
  });

  it("resolves display for multiple result rows with a SINGLE batched store call, not one per row (N+1 fix)", async () => {
    let batchCalls = 0;
    const store = makeStore();
    const batchingStore: import("../src/ports.js").AgentStore = {
      relationshipState: (s, i) => store.relationshipState(s, i),
      openLoops: (s, i) => store.openLoops(s, i),
      drifting: (s, i) => store.drifting(s, i),
      circle: (s, i) => store.circle(s, i),
      memoryWrite: (s, i) => store.memoryWrite(s, i),
      memorySearch: (s, q) => store.memorySearch(s, q),
      resolvePerson: (s, d) => store.resolvePerson(s, d),
      relationshipStateBatch: async (s, ids) => {
        batchCalls += 1;
        return store.relationshipStateBatch(s, ids);
      },
    };
    const port = {
      search: async (): Promise<AskDeviceSearchResponse> => ({
        v: 1,
        id: "r1",
        ok: true,
        results: [
          { person_id: "p_maya01", when: "2026-08-05T10:00:00Z", snippet: "a", thread_id: "t1", score: 0.9 },
          { person_id: "p_maya01", when: "2026-08-06T10:00:00Z", snippet: "b", thread_id: "t2", score: 0.8 },
        ],
      }),
    };
    const result = await searchMessages(ctx({ deviceSearch: port, store: batchingStore }), { query: "trip" });
    expect(batchCalls).toBe(1);
    expect(result.results.map((r) => r.display)).toEqual(["Maya", "Maya"]);
  });

  it("passes a parsed single-date `when` hint through as when_from/when_to", async () => {
    let received: { when_from?: string; when_to?: string } | null = null;
    const port = {
      search: async (req: { when_from?: string; when_to?: string }): Promise<AskDeviceSearchResponse> => {
        received = { when_from: req.when_from, when_to: req.when_to };
        return { v: 1, id: "r1", ok: true, results: [] };
      },
    };
    const result = await searchMessages(ctx({ deviceSearch: port }), { query: "trip", when: "2026-08-08" });
    expect(received).toEqual({ when_from: "2026-08-08T00:00:00Z", when_to: "2026-08-08T23:59:59Z" });
    expect(result.degraded).toBeUndefined();
  });

  it("passes a parsed date RANGE `when` hint through as when_from/when_to", async () => {
    let received: { when_from?: string; when_to?: string } | null = null;
    const port = {
      search: async (req: { when_from?: string; when_to?: string }): Promise<AskDeviceSearchResponse> => {
        received = { when_from: req.when_from, when_to: req.when_to };
        return { v: 1, id: "r1", ok: true, results: [] };
      },
    };
    await searchMessages(ctx({ deviceSearch: port }), { query: "trip", when: "2026-08-01..2026-08-08" });
    expect(received).toEqual({ when_from: "2026-08-01T00:00:00Z", when_to: "2026-08-08T23:59:59Z" });
  });

  it("SHOULD-FIX regression: an unparseable `when` hint runs the search unfiltered and reports degraded: when_unparsed, rather than silently ignoring it", async () => {
    let received: { when_from?: string; when_to?: string } | null = null;
    const port = {
      search: async (req: { when_from?: string; when_to?: string }): Promise<AskDeviceSearchResponse> => {
        received = { when_from: req.when_from, when_to: req.when_to };
        return { v: 1, id: "r1", ok: true, results: [] };
      },
    };
    const result = await searchMessages(ctx({ deviceSearch: port }), { query: "trip", when: "last week" });
    expect(received).toEqual({ when_from: undefined, when_to: undefined });
    expect(result.degraded).toBe("when_unparsed");
    expect(result.source).toBe("device"); // the search still ran — just unfiltered by date.
  });

  it("does not set degraded at all when no `when` hint was given", async () => {
    const port = { search: async (): Promise<AskDeviceSearchResponse> => ({ v: 1, id: "r1", ok: true, results: [] }) };
    const result = await searchMessages(ctx({ deviceSearch: port }), { query: "trip" });
    expect(result.degraded).toBeUndefined();
  });
});

describe("parseWhenHint", () => {
  it("parses a single ISO date into that whole day's range", () => {
    expect(parseWhenHint("2026-08-08")).toEqual({ when_from: "2026-08-08T00:00:00Z", when_to: "2026-08-08T23:59:59Z" });
  });

  it("parses an inclusive ISO date range", () => {
    expect(parseWhenHint("2026-08-01..2026-08-08")).toEqual({ when_from: "2026-08-01T00:00:00Z", when_to: "2026-08-08T23:59:59Z" });
  });

  it("rejects a reversed range (from after to)", () => {
    expect(parseWhenHint("2026-08-08..2026-08-01")).toBeNull();
  });

  it("does not attempt natural-language phrasing", () => {
    expect(parseWhenHint("last week")).toBeNull();
    expect(parseWhenHint("around March 3rd")).toBeNull();
    expect(parseWhenHint("")).toBeNull();
  });
});
