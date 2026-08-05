import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  composeDraftDelivery,
  proposeFollowUpDraft,
  RecordedFollowUpDraftProvider,
  type DraftProviderOutput,
  type FollowUpDraftProvider,
} from "./draft.js";

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as unknown;
}

const DIGEST = fixture("contracts/fixtures/digest_v2/understood.json");
const VOICE_PACK = fixture("contracts/fixtures/voice_pack_v2/maya.json");
const LICENSED_OUTPUT: DraftProviderOutput = {
  template_id: "acknowledge_open_thread",
  claim: { source: "open_thread", value: "asked whether you are coming, unanswered" },
};
const LICENSED_TEXT = "sorry i missed this, can you remind me?";

function mutateVoicePack(mutator: (pack: Record<string, unknown>) => void): unknown {
  const pack = structuredClone(VOICE_PACK) as Record<string, unknown>;
  mutator(pack);
  return pack;
}

describe("licensed follow-up drafts", () => {
  it("projects only bounded understanding, facts, and matching user-authored exemplars", async () => {
    const poisoned = structuredClone(DIGEST) as Record<string, unknown>;
    poisoned.corpus = { raw_counterpart_prose: "COUNTERPART_SECRET" };
    const relationships = poisoned.relationships as Array<Record<string, unknown>>;
    relationships[0] = {
      ...relationships[0],
      display: "DISPLAY_SECRET",
      handle: "+15551234567",
      raw_messages: ["COUNTERPART_SECRET"],
    };
    const provider = new RecordedFollowUpDraftProvider(LICENSED_OUTPUT);

    await expect(proposeFollowUpDraft(poisoned, "h_8f21a4c0", VOICE_PACK, provider)).resolves.toEqual({
      kind: "proposal",
      proposal: { contact_id: "h_8f21a4c0", text: LICENSED_TEXT },
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual({
      understanding: {
        register: "warm",
        relationship_kind: "close_friend",
        open_thread: "asked whether you are coming, unanswered",
        last_exchange_shape: "question_from_them",
        topics: ["climbing"],
        cadence_norm: "usually replies within an hour; two days is unusual",
      },
      facts: { dates: [], times: [], places: [], amounts: [], names: [] },
      voice_exemplars: [{
        text: "yes im down what time were u thinking",
        answered: "question_from_them",
        register: "warm",
      }],
    });
    expect(JSON.stringify(provider.calls[0])).not.toMatch(/COUNTERPART_SECRET|DISPLAY_SECRET|15551234567|contact_id|corpus|raw_messages/);
  });

  it("never turns arbitrary model prose into a production-usable proposal", async () => {
    for (const output of [
      { ...LICENSED_OUTPUT, text: "yes i already paid and booked the room" },
      { text: "yes i already paid and booked the room", claims: [LICENSED_OUTPUT.claim] },
      { template_id: "write_anything", claim: LICENSED_OUTPUT.claim },
    ]) {
      await expect(proposeFollowUpDraft(
        DIGEST,
        "h_8f21a4c0",
        VOICE_PACK,
        new RecordedFollowUpDraftProvider(output),
      )).resolves.toEqual({ kind: "decline", reason: "unlicensed_output" });
    }
  });

  it("declines cross-contact and mutable-license attacks", async () => {
    const swapped = mutateVoicePack((pack) => { pack.contact_id = "h_00000009"; });
    const notCalled = new RecordedFollowUpDraftProvider(LICENSED_OUTPUT);
    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", swapped, notCalled)).resolves.toEqual({
      kind: "decline",
      reason: "invalid_input",
    });
    expect(notCalled.calls).toHaveLength(0);

    const mutating: FollowUpDraftProvider = {
      generate: async (input) => {
        input.understanding.open_thread = "invented provider thread";
        return { template_id: "acknowledge_open_thread", claim: { source: "open_thread", value: "invented provider thread" } };
      },
    };
    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", VOICE_PACK, mutating)).resolves.toEqual({
      kind: "decline",
      reason: "unlicensed_output",
    });
  });

  it("strictly validates frozen voice_pack.v2 shape, register bounds, and timestamps", async () => {
    const invalidPacks = [
      mutateVoicePack((pack) => { pack.extra = true; }),
      mutateVoicePack((pack) => { pack.as_of = "2026-02-30T09:14:00Z"; }),
      mutateVoicePack((pack) => { pack.n_exemplars = 2; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).extra = true; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).median_len_chars = 0; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).avg_msgs_per_burst = 0; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).emoji_rate = 2; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).punctuation = "anything"; }),
      mutateVoicePack((pack) => { (pack.register as Record<string, unknown>).top_emoji = ["a", "b", "c", "d", "e", "f"]; }),
      mutateVoicePack((pack) => { ((pack.exemplars as unknown[])[0] as Record<string, unknown>).extra = true; }),
      mutateVoicePack((pack) => { ((pack.exemplars as unknown[])[0] as Record<string, unknown>).answered = "counterpart_prose"; }),
    ];
    for (const pack of invalidPacks) {
      await expect(proposeFollowUpDraft(
        DIGEST,
        "h_8f21a4c0",
        pack,
        new RecordedFollowUpDraftProvider(LICENSED_OUTPUT),
      )).resolves.toEqual({ kind: "decline", reason: "invalid_input" });
    }
  });

  it("declines provider failures and templates that exceed the voice-specific length gate", async () => {
    const throwing: FollowUpDraftProvider = { generate: async () => { throw new Error("offline"); } };
    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", VOICE_PACK, throwing)).resolves.toEqual({
      kind: "decline",
      reason: "provider_failure",
    });

    const tinyRegister = mutateVoicePack((pack) => {
      const register = pack.register as Record<string, unknown>;
      register.median_len_chars = 1;
      register.avg_msgs_per_burst = 1;
      delete register.p90_len_chars;
    });
    await expect(proposeFollowUpDraft(
      DIGEST,
      "h_8f21a4c0",
      tinyRegister,
      new RecordedFollowUpDraftProvider(LICENSED_OUTPUT),
    )).resolves.toEqual({ kind: "decline", reason: "unlicensed_output" });
  });

  it("binds Track I recipient resolution to the proposal contact before stripping it", async () => {
    const outcome = await proposeFollowUpDraft(
      DIGEST,
      "h_8f21a4c0",
      VOICE_PACK,
      new RecordedFollowUpDraftProvider(LICENSED_OUTPUT),
    );
    if (outcome.kind !== "proposal") throw new Error("licensed fixture did not produce a proposal");
    const { proposal } = outcome;
    const resolved = composeDraftDelivery(proposal, {
      contact_id: "h_8f21a4c0",
      recipient: { kind: "resolved", handle: "+15551234567" },
    });
    const unavailable = composeDraftDelivery(proposal, {
      contact_id: "h_8f21a4c0",
      recipient: { kind: "unavailable" },
    });
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
      fixture("contracts/schema/draft_delivery.v1.json") as object,
    );
    expect(validate(resolved)).toBe(true);
    expect(validate(unavailable)).toBe(true);
    expect(resolved?.recipient).toEqual({ kind: "resolved", handle: "+15551234567" });
    expect(unavailable?.recipient).toEqual({ kind: "unavailable" });

    expect(composeDraftDelivery(proposal, {
      contact_id: "h_00000009",
      recipient: { kind: "resolved", handle: "+15550000000" },
    })).toBeNull();
    // A structurally similar object has not passed the closed-template gate.
    expect(composeDraftDelivery(
      { contact_id: "h_8f21a4c0", text: "yes i already paid and booked the room" },
      { contact_id: "h_8f21a4c0", recipient: { kind: "unavailable" } },
    )).toBeNull();
  });

  it("rejects lone surrogates before proposal or delivery handoff", async () => {
    const badVoice = mutateVoicePack((pack) => {
      ((pack.exemplars as unknown[])[0] as Record<string, unknown>).text = "bad\ud800text";
    });
    await expect(proposeFollowUpDraft(
      DIGEST,
      "h_8f21a4c0",
      badVoice,
      new RecordedFollowUpDraftProvider(LICENSED_OUTPUT),
    )).resolves.toEqual({ kind: "decline", reason: "invalid_input" });

    expect(composeDraftDelivery(
      { contact_id: "h_8f21a4c0", text: "bad\ud800text" },
      { contact_id: "h_8f21a4c0", recipient: { kind: "unavailable" } },
    )).toBeNull();

    const handleOutcome = await proposeFollowUpDraft(
      DIGEST,
      "h_8f21a4c0",
      VOICE_PACK,
      new RecordedFollowUpDraftProvider(LICENSED_OUTPUT),
    );
    if (handleOutcome.kind !== "proposal") throw new Error("licensed fixture did not produce a proposal");
    expect(composeDraftDelivery(
      handleOutcome.proposal,
      { contact_id: "h_8f21a4c0", recipient: { kind: "resolved", handle: "bad\udfffhandle" } },
    )).toBeNull();
  });
});
