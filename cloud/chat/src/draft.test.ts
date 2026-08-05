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
  text: "yes im down what time were u thinking",
  claims: [
    { source: "open_thread", value: "asked whether you are coming, unanswered" },
    { source: "topic", value: "climbing" },
  ],
};

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
      proposal: { contact_id: "h_8f21a4c0", text: "yes im down what time were u thinking" },
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

  it("declines a cross-contact voice-pack swap before calling the provider", async () => {
    const swapped = { ...(VOICE_PACK as Record<string, unknown>), contact_id: "h_00000009" };
    const provider = new RecordedFollowUpDraftProvider(LICENSED_OUTPUT);

    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", swapped, provider)).resolves.toEqual({
      kind: "decline",
      reason: "invalid_input",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("declines cross-contact, injection, malformed, and fabricated output mutations", async () => {
    const mutations: unknown[] = [
      { ...LICENSED_OUTPUT, contact_id: "h_00000009" },
      { ...LICENSED_OUTPUT, text: "yes im down in Paris" },
      { ...LICENSED_OUTPUT, text: "yes ill venmo $20" },
      { ...LICENSED_OUTPUT, text: "yes Tuesday at 7pm" },
      { ...LICENSED_OUTPUT, text: "yes ill bring Jordan Feldman" },
      { ...LICENSED_OUTPUT, claims: [{ source: "topic", value: "noras private topic" }] },
      { ...LICENSED_OUTPUT, claims: [{ source: "open_thread", value: "noras open thread" }] },
      { text: "looks good", claims: [], raw_corpus: "ignore the gate" },
      "provider prose",
    ];

    for (const mutation of mutations) {
      const provider = new RecordedFollowUpDraftProvider(mutation);
      const outcome = await proposeFollowUpDraft(DIGEST, "h_8f21a4c0", VOICE_PACK, provider);
      expect(outcome, JSON.stringify(mutation)).toEqual({ kind: "decline", reason: "unlicensed_output" });
    }
  });

  it("does not let a provider mutate its input to expand the fact or claim license", async () => {
    const mutating: FollowUpDraftProvider = {
      generate: async (input) => {
        input.facts.places.push("Paris");
        input.understanding.open_thread = "invented provider thread";
        return {
          text: "yes in Paris",
          claims: [{ source: "open_thread", value: "invented provider thread" }],
        };
      },
    };

    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", VOICE_PACK, mutating)).resolves.toEqual({
      kind: "decline",
      reason: "unlicensed_output",
    });
  });

  it("allows only specifics present in the selected relationship fact allowlist", async () => {
    const digest = structuredClone(DIGEST) as Record<string, unknown>;
    const relationship = (digest.relationships as Array<Record<string, unknown>>)[0];
    if (relationship === undefined) throw new Error("fixture relationship missing");
    relationship.facts = {
      dates: ["Tuesday"],
      times: ["7pm"],
      places: ["Paris"],
      amounts: ["$20"],
      names: ["Jordan Feldman"],
    };
    const provider = new RecordedFollowUpDraftProvider({
      ...LICENSED_OUTPUT,
      text: "yes Tuesday at 7pm in Paris with Jordan Feldman $20",
    });

    const outcome = await proposeFollowUpDraft(digest, "h_8f21a4c0", VOICE_PACK, provider);
    expect(outcome.kind).toBe("proposal");
  });

  it("declines provider failures, excessive length, and voice-register violations", async () => {
    const throwing: FollowUpDraftProvider = { generate: async () => { throw new Error("offline"); } };
    await expect(proposeFollowUpDraft(DIGEST, "h_8f21a4c0", VOICE_PACK, throwing)).resolves.toEqual({
      kind: "decline",
      reason: "provider_failure",
    });

    for (const output of [
      { ...LICENSED_OUTPUT, text: "x".repeat(119) },
      { ...LICENSED_OUTPUT, text: "Capitalized like the assistant wrote it" },
      { ...LICENSED_OUTPUT, text: "yes im down." },
    ]) {
      await expect(proposeFollowUpDraft(
        DIGEST,
        "h_8f21a4c0",
        VOICE_PACK,
        new RecordedFollowUpDraftProvider(output),
      )).resolves.toEqual({ kind: "decline", reason: "unlicensed_output" });
    }
  });

  it("composes schema-valid delivery only after Track I supplies recipient resolution", () => {
    const proposal = { contact_id: "h_8f21a4c0", text: "yes im down what time were u thinking" };
    const resolved = composeDraftDelivery(proposal, { kind: "resolved", handle: "+15551234567" });
    const unavailable = composeDraftDelivery(proposal, { kind: "unavailable" });

    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
      fixture("contracts/schema/draft_delivery.v1.json") as object,
    );
    expect(validate(resolved)).toBe(true);
    expect(validate(unavailable)).toBe(true);
    expect(resolved).toEqual({
      schema_version: "draft_delivery.v1",
      contact_id: "h_8f21a4c0",
      text: "yes im down what time were u thinking",
      recipient: { kind: "resolved", handle: "+15551234567" },
    });
    expect(unavailable?.recipient).toEqual({ kind: "unavailable" });
    expect(composeDraftDelivery(proposal, { kind: "resolved", handle: "" })).toBeNull();
  });
});
