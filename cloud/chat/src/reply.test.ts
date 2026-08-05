import { describe, expect, it } from "vitest";
import type { WaitingOnMeEvidenceRow, WaitingOnMeResult } from "./waiting-on-me.js";
import {
  composeWaitingOnMeReply,
  deterministicWaitingOnMeRenderer,
  UNKNOWN_SYNC_HORIZON,
  type RenderedWaitingOnMeAnswer,
} from "./reply.js";

function evidence(): WaitingOnMeResult {
  return {
    name: "waiting_on_me",
    synced_through: "2026-08-01T09:10:00Z",
    rows: [{
      contact_id: "h_8f21a4c0",
      display: "Maya",
      open_thread: "asked whether you are coming, unanswered",
    }],
  };
}

describe("licensed chat reply gate", () => {
  it("composes a deterministic answer whose claims and freshness trace to the query result", () => {
    expect(composeWaitingOnMeReply(evidence())).toEqual({
      schema_version: "chat_reply.v1",
      kind: "answer",
      text: "Maya had this open at the last sync: asked whether you are coming, unanswered. As of Aug 1, 2026 at 9:10 AM UTC.",
      synced_through: "2026-08-01T09:10:00Z",
      licenses: [{
        contact_id: "h_8f21a4c0",
        display: "Maya",
        reason: "asked whether you are coming, unanswered",
      }],
    });
  });

  it("declines an injected other-contact name even when the claimed contact_id is licensed", () => {
    const injectName = (): RenderedWaitingOnMeAnswer => ({
      text: "Nora had this open at the last sync: asked whether you are coming, unanswered.",
      claims: [{
        contact_id: "h_8f21a4c0",
        display: "Nora",
        relationship_claim: "asked whether you are coming, unanswered",
      }],
    });

    const reply = composeWaitingOnMeReply(evidence(), injectName);
    expect(reply.kind).toBe("decline");
    expect(reply.licenses).toEqual([]);
    expect(reply.text).not.toContain("Nora");
  });

  it("declines an injected number or unlicensed relationship detail in renderer prose", () => {
    const injectNumber = (rows: readonly WaitingOnMeEvidenceRow[]): RenderedWaitingOnMeAnswer => {
      const rendered = deterministicWaitingOnMeRenderer(rows);
      return { ...rendered, text: `${rendered.text} Call 15551234567 about dinner.` };
    };

    const reply = composeWaitingOnMeReply(evidence(), injectNumber);
    expect(reply.kind).toBe("decline");
    expect(reply.text).not.toContain("15551234567");
    expect(reply.text).not.toContain("dinner");
  });

  it("declines a stale present-tense rewrite of otherwise licensed evidence", () => {
    const presentTense = (rows: readonly WaitingOnMeEvidenceRow[]): RenderedWaitingOnMeAnswer => {
      const rendered = deterministicWaitingOnMeRenderer(rows);
      return {
        ...rendered,
        text: "Maya has this open now: asked whether you are coming, unanswered.",
      };
    };

    const reply = composeWaitingOnMeReply(evidence(), presentTense);
    expect(reply.kind).toBe("decline");
    expect(reply.text).toContain("As of Aug 1, 2026 at 9:10 AM UTC.");
  });

  it("fails closed for empty rows, a missing horizon, and an invalid evidence shape", () => {
    const empty = composeWaitingOnMeReply({ ...evidence(), rows: [] });
    expect(empty.kind).toBe("decline");
    expect(empty.synced_through).toBe("2026-08-01T09:10:00Z");
    expect(empty.text).toContain("As of Aug 1, 2026 at 9:10 AM UTC.");

    const missingHorizon = composeWaitingOnMeReply({ name: "waiting_on_me", rows: evidence().rows });
    expect(missingHorizon).toEqual({
      schema_version: "chat_reply.v1",
      kind: "decline",
      text: "I can't answer because sync freshness or licensed evidence is unavailable.",
      synced_through: UNKNOWN_SYNC_HORIZON,
      licenses: [],
    });

    const leakedDigestShape = composeWaitingOnMeReply({
      ...evidence(),
      relationships: [{ display: "private full digest" }],
    });
    expect(leakedDigestShape.kind).toBe("decline");
    expect(leakedDigestShape.text).not.toContain("private full digest");
  });

  it("fails closed when renderer output is malformed, duplicated, cross-contact, or throws", () => {
    const badOutputs: Array<() => unknown> = [
      () => ({ text: "", claims: [] }),
      () => ({ text: "Maya", claims: [], extra: "field" }),
      () => ({
        text: "Nora had this open at the last sync: unrelated.",
        claims: [{ contact_id: "h_00000009", display: "Nora", relationship_claim: "unrelated" }],
      }),
      () => {
        const claim = {
          contact_id: "h_8f21a4c0",
          display: "Maya",
          relationship_claim: "asked whether you are coming, unanswered",
        };
        return { text: "duplicate", claims: [claim, claim] };
      },
      () => { throw new Error("renderer unavailable"); },
    ];

    for (const renderer of badOutputs) {
      const reply = composeWaitingOnMeReply(evidence(), renderer);
      expect(reply.kind).toBe("decline");
      expect(reply.licenses).toEqual([]);
    }
  });
});
