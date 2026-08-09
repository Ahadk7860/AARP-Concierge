import { describe, expect, it } from "vitest";
import {
  buildEvidencePool,
  defaultDegrade,
  extractClaims,
  runVerifiedTurn,
  verify,
  type ToolCallRecord,
} from "../src/verifier.js";

function relationshipCall(): ToolCallRecord {
  return {
    tool: "relationship_state",
    output: {
      person_id: "p_maya01",
      display: "Maya",
      lifecycle_stage: "steady",
      expected_gap_days: 3,
      overdue_by_days: 2,
      momentum: 0.8,
      initiation_ratio: 0.5,
      register: "warm",
      relationship_kind: "close_friend",
      last_contact: "2026-08-05T10:00:00Z",
      evidence: [{ source: "relationship", id: "p_maya01" }],
    },
  };
}

function openLoopCall(): ToolCallRecord {
  return {
    tool: "open_loops",
    output: {
      loops: [{
        loop_id: "loop_1",
        person_id: "p_maya01",
        display: "Maya",
        kind: "question",
        direction: "i_owe_them",
        description: "asked whether you're coming to the trip on August 8, 2026",
        age_days: 4,
      }],
      evidence: [{ source: "open_loop", id: "loop_1" }],
    },
  };
}

describe("buildEvidencePool", () => {
  it("collects words, digit runs, and raw strings from tool outputs only", () => {
    const pool = buildEvidencePool([relationshipCall(), openLoopCall()]);
    expect(pool.words.has("maya")).toBe(true);
    expect(pool.words.has("august")).toBe(true);
    expect(pool.numbers.has("8")).toBe(true);
    expect(pool.numbers.has("2026")).toBe(true);
    expect(pool.refs).toEqual([
      { source: "relationship", id: "p_maya01" },
      { source: "open_loop", id: "loop_1" },
    ]);
  });

  it("strips leading zeros so date-shaped numbers still match plain digit claims", () => {
    const pool = buildEvidencePool([{
      tool: "relationship_state",
      output: { last_contact: "2026-08-05T10:00:00Z", evidence: [] },
    }]);
    expect(pool.numbers.has("05")).toBe(true);
    expect(pool.numbers.has("5")).toBe(true);
  });
});

describe("extractClaims", () => {
  it("finds names, numbers, ISO dates, and phone handles independently", () => {
    const claims = extractClaims(
      "Maya asked about the trip on 2026-08-08 and mentioned 3 friends. Reach her at +1 415 555 0100.",
    );
    const kinds = new Set(claims.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["date", "handle", "name", "number"]));
    expect(claims.find((c) => c.kind === "name")?.value).toBe("Maya");
    expect(claims.find((c) => c.kind === "date")?.value).toBe("2026-08-08");
    expect(claims.some((c) => c.kind === "handle" && c.value.includes("415"))).toBe(true);
    expect(claims.some((c) => c.kind === "number" && c.value === "3")).toBe(true);
  });

  it("recognizes month-name dates and does not double-count them as bare numbers", () => {
    const claims = extractClaims("Maya's message was on August 8, 2026.");
    const dateClaims = claims.filter((c) => c.kind === "date");
    const numberClaims = claims.filter((c) => c.kind === "number");
    expect(dateClaims).toHaveLength(1);
    expect(dateClaims[0]!.value.toLowerCase()).toContain("august 8");
    // "8" and "2026" are consumed by the date match, not re-flagged as standalone numbers.
    expect(numberClaims).toHaveLength(0);
  });

  it("does not flag common sentence-opening capitalized words as name claims", () => {
    const claims = extractClaims("Hey! I checked and I'm not sure. Thanks for asking.");
    expect(claims.filter((c) => c.kind === "name")).toHaveLength(0);
  });

  it("extracts emails and @mentions as handle claims", () => {
    const claims = extractClaims("Reach her at maya@example.com or @maya_h on the app.");
    const handles = claims.filter((c) => c.kind === "handle").map((c) => c.value);
    expect(handles).toContain("maya@example.com");
    expect(handles).toContain("@maya_h");
  });
});

describe("verify — I2: every claim must trace to this turn's tool results", () => {
  it("passes prose built entirely from this turn's evidence", () => {
    const pool = buildEvidencePool([relationshipCall(), openLoopCall()]);
    const result = verify(
      "Maya has an open question from August 8, 2026 — she asked whether you're coming to the trip.",
      pool,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a fabricated name not present in any tool result this turn", () => {
    const pool = buildEvidencePool([relationshipCall()]);
    const result = verify("Jordan asked you a question yesterday.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.claim).toEqual({ kind: "name", value: "Jordan" });
    }
  });

  it("rejects a fabricated number (e.g. an invented day count) absent from tool results", () => {
    const pool = buildEvidencePool([relationshipCall()]);
    const result = verify("Maya has been silent for 47 days.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "number" && v.claim.value === "47")).toBe(true);
    }
  });

  it("rejects a fabricated phone number even when a different one is grounded", () => {
    const pool = buildEvidencePool([{
      tool: "search_messages",
      output: { results: [], source: "device", evidence: [], note: "call +14155550100" },
    }]);
    const result = verify("Her number is +1 415 555 9999.", pool);
    expect(result.ok).toBe(false);
  });

  it("rejects a fabricated date even when the year and month are separately grounded", () => {
    // Guards against a shallow implementation that only checks component numbers appear
    // ANYWHERE, rather than the full date being groundable as stated.
    const pool = buildEvidencePool([{
      tool: "relationship_state",
      output: { last_contact: "2026-08-05T10:00:00Z", evidence: [] },
    }]);
    // Day 30 is not grounded even though "2026" and "August" both are individually.
    const result = verify("She last spoke to you on August 30, 2026.", pool);
    expect(result.ok).toBe(false);
  });

  it("passes an empty-of-claims answer (no names/handles/dates/numbers to support)", () => {
    const pool = buildEvidencePool([]);
    const result = verify("I don't have anything to report right now.", pool);
    expect(result.ok).toBe(true);
  });

  it("never lets a prior turn's evidence leak in — pool is scoped to what's passed", () => {
    // Simulates: caller must rebuild the pool per turn. A pool built from an empty call
    // list (this turn made no tool calls) cannot support any claim, however true.
    const pool = buildEvidencePool([]);
    const result = verify("Maya asked about the trip.", pool);
    expect(result.ok).toBe(false);
  });
});

describe("runVerifiedTurn — regenerate once, then degrade (I1, I2)", () => {
  it("returns the first draft verified when it already passes", async () => {
    const pool = buildEvidencePool([relationshipCall()]);
    const outcome = await runVerifiedTurn(
      "Maya's relationship is in a steady stage.",
      pool,
      async () => { throw new Error("must not be called"); },
    );
    expect(outcome).toEqual({
      status: "verified",
      text: "Maya's relationship is in a steady stage.",
      attempt: "first",
    });
  });

  it("regenerates exactly once and ships the corrected draft when it then passes", async () => {
    const pool = buildEvidencePool([relationshipCall()]);
    let regenerateCalls = 0;
    let receivedSummary = "";
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      pool,
      async (summary) => {
        regenerateCalls += 1;
        receivedSummary = summary;
        return "Maya's relationship is in a steady stage.";
      },
    );
    expect(regenerateCalls).toBe(1);
    expect(receivedSummary).toContain("Jordan");
    expect(receivedSummary).toContain("unsupported_name");
    expect(outcome).toEqual({
      status: "verified",
      text: "Maya's relationship is in a steady stage.",
      attempt: "regenerated",
    });
  });

  it("degrades to a grounded, evidence-only summary when the regenerate also fails, and never returns free text", async () => {
    const pool = buildEvidencePool([relationshipCall()]);
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      pool,
      async () => "Priya also asked something.",
    );
    expect(outcome.status).toBe("degraded");
    if (outcome.status === "degraded") {
      // The degraded text must itself be verifier-clean — it is built from evidence refs,
      // not model prose, so it cannot reintroduce a fabrication.
      const check = verify(outcome.text, pool);
      expect(check.ok).toBe(true);
      expect(outcome.violations.some((v) => v.claim.value === "Priya")).toBe(true);
    }
  });

  it("degrades (never throws, never ships unverified text) when the regenerate call itself throws", async () => {
    const pool = buildEvidencePool([relationshipCall()]);
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      pool,
      async () => { throw new Error("model_call_failed"); },
    );
    expect(outcome.status).toBe("degraded");
  });

  it("default degrade reports evidence refs, and reports honest emptiness with zero tool calls", () => {
    const emptyPool = buildEvidencePool([]);
    expect(defaultDegrade(emptyPool)).toMatch(/couldn't verify/);

    const pool = buildEvidencePool([relationshipCall(), openLoopCall()]);
    const text = defaultDegrade(pool);
    expect(text).toContain("relationship:p_maya01");
    expect(text).toContain("open_loop:loop_1");
  });
});
