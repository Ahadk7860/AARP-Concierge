import { describe, expect, it } from "vitest";
import {
  buildEvidencePool,
  defaultDegrade,
  extractClaims,
  hasUsefulAlternative,
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

function generalCall(answer: string): ToolCallRecord {
  return {
    tool: "general",
    output: {
      answer,
      source: "model_knowledge",
      evidence: [{ source: "general", id: "gen_1" }],
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

  it("populates `names` ONLY from display-keyed leaves, not from every word in `words`", () => {
    const pool = buildEvidencePool([relationshipCall(), openLoopCall()]);
    expect(pool.names.has("maya")).toBe(true);
    // "trip" and "august" are real words in this turn's evidence (openLoopCall's
    // description) and DO land in `words` — but must NOT land in `names`. This is the
    // exact distinction the BLOCKING fix depends on: `words` and `names` are not the
    // same set, and a "name" claim is checked against `names` only.
    expect(pool.words.has("trip")).toBe(true);
    expect(pool.names.has("trip")).toBe(false);
    // "loop" is not a person and must not enter `names`, regardless of where any
    // similarly-spelled word came from (the id "loop_1" itself is excluded from every
    // bucket — see the dedicated rawStrings test below; `words` may still contain
    // "loop" via unrelated text such as the evidence ref's `source: "open_loop"` label,
    // which is harmless since `words` no longer backs name-grounding at all).
    expect(pool.names.has("loop")).toBe(false);
  });

  it("excludes identifier-keyed leaves from rawStrings entirely (SHOULD-FIX: no weak handle substring match off an opaque id)", () => {
    const pool = buildEvidencePool([{
      tool: "open_loops",
      output: { loops: [{ loop_id: "loop_12", person_id: "p_maya01", display: "Maya", kind: "question", direction: "i_owe_them", description: "asked about the trip", age_days: 4 }], evidence: [] },
    }]);
    expect(pool.rawStrings.some((s) => s.includes("loop_12"))).toBe(false);
    expect(pool.rawStrings.some((s) => s.includes("p_maya01"))).toBe(false);
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

  it("BLOCKING regression: an ordinary word in evidence prose must not ground a fabricated person name", () => {
    // openLoopCall()'s description contains "trip" as an ordinary topic noun, not a
    // person. Before the fix, `words` (populated from ALL prose) backed the name check,
    // so "Trip" verified as a real person purely because the word "trip" appeared
    // somewhere in this turn's evidence.
    const pool = buildEvidencePool([openLoopCall()]);
    expect(pool.words.has("trip")).toBe(true); // the word is legitimately in evidence...
    const result = verify("Trip asked about the plan again.", pool);
    expect(result.ok).toBe(false); // ...but "Trip" the PERSON is not.
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "name" && v.claim.value === "Trip")).toBe(true);
    }
  });

  it("BLOCKING regression: an opaque id token must not ground a fabricated person name via underscore-tokenization", () => {
    // "loop_12" as a loop_id tokenizes on `_` into "loop" and "12". Before the fix, the
    // word "loop" leaked into `words` (ids were only excluded from `numbers`), so a
    // fabricated "Loop" name claim verified as grounded.
    const call: ToolCallRecord = {
      tool: "open_loops",
      output: {
        loops: [{ loop_id: "loop_12", person_id: "p_maya01", display: "Maya", kind: "question", direction: "i_owe_them", description: "asked about the trip", age_days: 4 }],
        evidence: [{ source: "open_loop", id: "loop_12" }],
      },
    };
    const pool = buildEvidencePool([call]);
    const result = verify("Loop asked about the trip.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "name" && v.claim.value === "Loop")).toBe(true);
    }
  });

  it("accepted tradeoff, pinned: a third party named only inside prose (not a display field) does not ground — forces a regenerate rather than shipping an ungrounded name", () => {
    const call: ToolCallRecord = {
      tool: "search_messages",
      output: {
        results: [{ person_id: "p_maya01", display: "Maya", when: "2026-08-05T10:00:00Z", snippet: "maya said jordan is coming too", thread_id: "t1" }],
        source: "device",
        evidence: [{ source: "message", id: "t1" }],
      },
    };
    const pool = buildEvidencePool([call]);
    // Maya is grounded (via `display`)...
    expect(verify("Maya said something about who's coming.", pool).ok).toBe(true);
    // ...but Jordan, named only inside the snippet text, is not — even though the exact
    // word "jordan" is present in this turn's evidence.
    expect(pool.words.has("jordan")).toBe(true);
    const result = verify("Jordan is coming too.", pool);
    expect(result.ok).toBe(false);
  });

  it("SHOULD-FIX regression: a short @mention must not verify off a weak substring match against an opaque id", () => {
    // "@12" is a valid (if short) MENTION_RE match. Before the fix, `rawStrings` included
    // id-derived strings like "loop_12", and the handle check was a bare substring test,
    // so "@12" verified as grounded purely because "12" is a substring of "loop_12".
    const call: ToolCallRecord = {
      tool: "open_loops",
      output: {
        loops: [{ loop_id: "loop_12", person_id: "p_maya01", display: "Maya", kind: "question", direction: "i_owe_them", description: "asked about the trip", age_days: 4 }],
        evidence: [],
      },
    };
    const pool = buildEvidencePool([call]);
    const result = verify("Reach out @12 about it.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "handle")).toBe(true);
    }
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

describe("the `general` tool must never ground a person-name or handle claim (Task 1's critical constraint)", () => {
  it("THE POINT: a general result mentioning a real person's name must NOT let the agent assert a relationship fact about them", () => {
    // Adversarial scenario the task calls out explicitly: the user steers `general` into
    // asserting something about a name that also happens to be a real person in their
    // life. No relationship_state/open_loops/drifting/circle/search_messages/memory call
    // was made for this person this turn — the ONLY tool result mentioning "Maya" is
    // `general`'s free-text answer. The verifier must still reject a relationship claim
    // about her, exactly as if the name had never appeared anywhere this turn.
    const pool = buildEvidencePool([
      generalCall("Maya Chen, born in 1990, is a notable public figure known for her writing."),
    ]);
    const result = verify("Maya is overdue for a reply and has been drifting from you.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "name" && v.claim.value === "Maya")).toBe(true);
    }
  });

  it("a name asserted only via `general` does not populate `names`, even though the word is in `words`", () => {
    const pool = buildEvidencePool([generalCall("Maya Chen is a well-known software engineer.")]);
    expect(pool.words.has("maya")).toBe(true);
    expect(pool.names.has("maya")).toBe(false);
  });

  it("a handle mentioned only via `general` must NOT ground a handle claim", () => {
    const pool = buildEvidencePool([generalCall("You can reach Acme Corp support at support@acme.com.")]);
    // Present in the unrestricted pool (dates/general prose are allowed to ground world
    // facts)...
    expect(pool.rawStrings.some((s) => s.includes("support@acme.com"))).toBe(true);
    // ...but excluded from the handle-grounding set specifically.
    expect(pool.handleRawStrings.some((s) => s.includes("support@acme.com"))).toBe(false);
    const result = verify("Reach her at support@acme.com.", pool);
    expect(result.ok).toBe(false);
  });

  it("a phone-shaped handle mentioned only via `general` must NOT ground a handle claim", () => {
    const pool = buildEvidencePool([generalCall("The main switchboard number is +14155550100.")]);
    const result = verify("Call her at +1 415 555 0100.", pool);
    expect(result.ok).toBe(false);
  });

  it("dates and numbers from `general` DO ground ordinary world-fact claims — only names/handles are restricted", () => {
    // Deliberately proper-noun-free (see the RESIDUAL RISK note in verifier.ts's header):
    // `extractClaims`'s PROPER_NOUN_RE cannot distinguish "Maya" from "Paris" — ANY
    // capitalized word is a candidate "name" claim, and `general` grounds none of them by
    // design. A world-fact sentence that happens to name a place/thing still gets flagged
    // and degrades; this case isolates the number/date grounding this test is actually for.
    const pool = buildEvidencePool([generalCall("The tower was finished in 1889 and stands 330 meters tall.")]);
    const result = verify("The tower was finished in 1889 and stands 330 meters tall.", pool);
    expect(result.ok).toBe(true);
  });

  it("a name IS still grounded when it comes from a real person-bearing tool this same turn, alongside an unrelated `general` call", () => {
    // Proves the fix isn't over-broad: `general` being present in the same turn must not
    // poison a legitimately grounded claim from relationship_state.
    const pool = buildEvidencePool([relationshipCall(), generalCall("Paris is the capital of France.")]);
    const result = verify("Maya's relationship with you is steady.", pool);
    expect(result.ok).toBe(true);
  });

  it("evidence refs from `general` carry a distinct source, never a person-scoped one", () => {
    const pool = buildEvidencePool([generalCall("Some world fact.")]);
    expect(pool.refs).toEqual([{ source: "general", id: "gen_1" }]);
    for (const ref of pool.refs) {
      expect(["relationship", "open_loop", "relationship_edge", "memory", "message", "send"]).not.toContain(ref.source);
    }
  });
});

describe("hasUsefulAlternative — Task 2's release-gate check for refusal quality", () => {
  it("flags a bare decline with no alternative as NOT useful", () => {
    expect(hasUsefulAlternative("I can't answer that.")).toBe(false);
    expect(hasUsefulAlternative("Sorry, I don't know.")).toBe(false);
  });

  it("recognizes defaultDegrade's honest-emptiness text (no tool calls at all) as useful", () => {
    expect(hasUsefulAlternative(defaultDegrade([]))).toBe(true);
  });

  it("recognizes defaultDegrade's found-evidence text as useful", () => {
    expect(hasUsefulAlternative(defaultDegrade([relationshipCall()]))).toBe(true);
  });
});

describe("runVerifiedTurn — regenerate once, then degrade (I1, I2)", () => {
  it("returns the first draft verified when it already passes", async () => {
    const outcome = await runVerifiedTurn(
      "Maya's relationship is in a steady stage.",
      [relationshipCall()],
      async () => { throw new Error("must not be called"); },
    );
    expect(outcome).toEqual({
      status: "verified",
      text: "Maya's relationship is in a steady stage.",
      attempt: "first",
    });
  });

  it("regenerates exactly once and ships the corrected draft when it then passes", async () => {
    let regenerateCalls = 0;
    let receivedSummary = "";
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      [relationshipCall()],
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
    const calls = [relationshipCall()];
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      calls,
      async () => "Priya also asked something.",
    );
    expect(outcome.status).toBe("degraded");
    if (outcome.status === "degraded") {
      // The degraded text must itself be verifier-clean — it is built from this turn's
      // tool calls, not model prose, so it cannot reintroduce a fabrication. It also must
      // not surface internal hashed identifiers to the user.
      const pool = buildEvidencePool(calls);
      const check = verify(outcome.text, pool);
      expect(check.ok).toBe(true);
      expect(outcome.text).not.toContain("p_maya01");
      expect(outcome.text).toContain("Maya");
      expect(outcome.violations.some((v) => v.claim.value === "Priya")).toBe(true);
    }
  });

  it("degrades (never throws, never ships unverified text) when the regenerate call itself throws", async () => {
    const outcome = await runVerifiedTurn(
      "Jordan is drifting away.",
      [relationshipCall()],
      async () => { throw new Error("model_call_failed"); },
    );
    expect(outcome.status).toBe("degraded");
  });

  it("default degrade renders human-readable prose from display/description fields, and reports honest emptiness with zero tool calls", () => {
    expect(defaultDegrade([])).toMatch(/couldn't verify/);

    const text = defaultDegrade([relationshipCall(), openLoopCall()]);
    // Human-readable facts, drawn from `display`/`lifecycle_stage`/`description` —
    // never the raw person_id/loop_id hashes.
    expect(text).toContain("Maya: steady.");
    expect(text).toContain("asked whether you're coming to the trip on August 8, 2026");
    expect(text).not.toContain("p_maya01");
    expect(text).not.toContain("loop_1");
  });

  it("never lets a coincidental digit fragment inside an opaque id ground an unrelated number claim", async () => {
    const call: ToolCallRecord = {
      tool: "open_loops",
      output: {
        loops: [{ loop_id: "loop_12", person_id: "p_maya01", display: "Maya", kind: "question", direction: "i_owe_them", description: "asked about the trip", age_days: 4 }],
        evidence: [{ source: "open_loop", id: "loop_12" }],
      },
    };
    // "12" appears only inside the opaque id "loop_12" — never as a standalone number
    // anywhere in the tool output — so a claim of "12" must be rejected, not "grounded"
    // by the coincidental digit fragment inside that id.
    const pool = buildEvidencePool([call]);
    const result = verify("Maya has 12 open loops with you.", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.claim.kind === "number" && v.claim.value === "12")).toBe(true);
    }
  });
});
