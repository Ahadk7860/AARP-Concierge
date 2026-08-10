// The zod mirror versus the frozen JSON Schema, decision for decision.
//
// Hand-mirroring a schema in a second language is a drift machine, and this track has
// now shipped drift in BOTH directions from the same file:
//
//   too strict — `archetype`, `first_contact_at`, `last_contact_at` and the two
//                `corpus` timestamps were `.nullable()` but not `.optional()`, though
//                none is in the frozen `required` list. Track A would have received a
//                400 for a document `validate_fixtures.py` calls valid.
//   too loose  — `whole_life` used `.passthrough()` under a comment asserting the
//                frozen schema allows extra keys. It sets `additionalProperties: false`.
//
// Neither was visible against the committed fixtures, because every fixture is fully
// populated and none carries a junk key. Eyeballing the two definitions is what
// produced the bug; this file stops eyeballing and compares the two validators'
// ANSWERS over documents built to probe exactly the places they can disagree.
//
// ajv is the reference because CONTRACTS.md § 1 says so: "The canonical definitions are
// the JSON Schemas in contracts/schema/. They are the arbiter when a language mirror
// disagrees."

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { ZodType } from "zod";
import { digestSchema, voicePackSchema, chatReplyV2Schema, chatRouteV1Schema, heartbeatSchema } from "./schemas.js";
import type { ChatReplyV2 } from "../../shared/src/contracts.js";

const SCHEMA_DIR = join(process.cwd(), "contracts", "schema");
const FIXTURE_DIR = join(process.cwd(), "contracts", "fixtures");

const ajv = new Ajv2020({ strict: false, allErrors: true });
// CONTRACTS.md § 6: ISO 8601 UTC with a Z. ajv-formats' `date-time` would accept
// `+00:00` offsets, which § 6 forbids and the zod mirror rejects — using it here would
// manufacture a disagreement that is not real.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

// `digest.v2.json` reaches into `digest.v1.json` for `corpus` and `whole_life`. Register
// it under its relative name so those `$ref`s resolve; `compile()` strips `$id` from the
// copy it hands to ajv, so this registration cannot clash with compiling v1 directly.
{
  const v1 = JSON.parse(readFileSync(join(SCHEMA_DIR, "digest.v1.json"), "utf8")) as Record<
    string,
    unknown
  >;
  delete v1["$id"];
  delete v1["$schema"];
  ajv.addSchema(v1, "digest.v1.json");
}

// `chat_reply.v2.json` (like `chat_reply.v1.json` before it) reaches into
// `draft_delivery.v1.json` for `follow_up_draft`. Same registration move as digest.v1
// above — compiling chat_reply.v2.json directly would otherwise throw "can't resolve
// reference draft_delivery.v1.json" the first time a case exercises that field.
{
  const draftDelivery = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "draft_delivery.v1.json"), "utf8"),
  ) as Record<string, unknown>;
  delete draftDelivery["$id"];
  delete draftDelivery["$schema"];
  ajv.addSchema(draftDelivery, "draft_delivery.v1.json");
}

function compile(name: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as Record<
    string,
    unknown
  >;
  delete schema["$id"];
  delete schema["$schema"];
  return ajv.compile(schema);
}

function load(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, ...parts), "utf8")) as Record<
    string,
    unknown
  >;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A digest with ONLY the fields `digest.v1.json` lists as required, at every level. */
export const MINIMAL_DIGEST = {
  schema_version: "digest.v1",
  user_id: "usr_minimal00000001",
  device_id: "dev_minimal00000001",
  generated_at: "2026-08-01T09:14:00Z",
  corpus: {
    message_count: 0,
    thread_count: 0,
    span_days: 0,
    health: "thin",
    as_of: "2026-08-01T09:14:00Z",
  },
  relationships: [
    {
      contact_id: "h_8f21a4c0",
      display: "Maya",
      is_group: false,
      message_count: 1,
      sent_count: 1,
      received_count: 0,
      days_since_last_contact: 0,
      momentum_90d: 0,
      initiation_ratio: 0,
      // AMENDMENT-001 made these four REQUIRED, so a minimal digest carries them. That
      // this test failed the moment the schema changed is the point of it: a
      // hand-written zod mirror stays correct right up until the first real schema
      // change, and this differential is what notices.
      last_from_me: false,
      max_gap_days: 0,
      unanswered_question: false,
      facts: { dates: [], times: [], places: [], amounts: [], names: [] },
      as_of: "2026-08-01T09:14:00Z",
    },
  ],
  whole_life: { as_of: "2026-08-01T09:14:00Z" },
} as const;

/**
 * Documents chosen to sit on the boundaries where the two validators can disagree:
 * a fully-populated fixture, a minimal one, one with each optional field individually
 * removed, and one with a junk key at each level.
 */
function digestCases(): Array<{ label: string; doc: unknown }> {
  const full = load("digest", "healthy.json");
  const cases: Array<{ label: string; doc: unknown }> = [
    { label: "fixture:healthy", doc: full },
    { label: "fixture:thin", doc: load("digest", "thin.json") },
    { label: "fixture:fixable", doc: load("digest", "fixable_keep_messages_30d.json") },
    { label: "minimal", doc: MINIMAL_DIGEST },
  ];

  // Drop each top-level corpus key in turn. Required ones must fail in BOTH; optional
  // ones must pass in BOTH. This is the exact axis the `.optional()` bug lived on.
  const corpusKeys = Object.keys((full["corpus"] as Record<string, unknown>) ?? {});
  for (const key of corpusKeys) {
    const doc = clone(full);
    delete (doc["corpus"] as Record<string, unknown>)[key];
    cases.push({ label: `corpus without ${key}`, doc });
  }

  // Same for every relationship key.
  const rels = full["relationships"] as Array<Record<string, unknown>>;
  const relKeys = Object.keys(rels[0] ?? {});
  for (const key of relKeys) {
    const doc = clone(full);
    delete (doc["relationships"] as Array<Record<string, unknown>>)[0]![key];
    cases.push({ label: `relationship without ${key}`, doc });
  }

  // And every whole_life key.
  for (const key of Object.keys((full["whole_life"] as Record<string, unknown>) ?? {})) {
    const doc = clone(full);
    delete (doc["whole_life"] as Record<string, unknown>)[key];
    cases.push({ label: `whole_life without ${key}`, doc });
  }

  // Junk keys at each level — the axis `.passthrough()` lived on.
  for (const path of ["", "corpus", "whole_life"]) {
    const doc = clone(full);
    const target = path === "" ? doc : (doc[path] as Record<string, unknown>);
    target["totally_unexpected"] = 1;
    cases.push({ label: `junk key in ${path || "(root)"}`, doc });
  }
  {
    const doc = clone(full);
    (doc["relationships"] as Array<Record<string, unknown>>)[0]!["totally_unexpected"] = 1;
    cases.push({ label: "junk key in relationship", doc });
  }

  // Type-level probes: integer vs number, and null where null is not allowed.
  {
    const doc = clone(full);
    (doc["relationships"] as Array<Record<string, unknown>>)[0]!["days_since_last_contact"] = 1.5;
    cases.push({ label: "fractional days_since_last_contact", doc });
  }
  {
    const doc = clone(full);
    (doc["corpus"] as Record<string, unknown>)["span_days"] = 2.5;
    cases.push({ label: "fractional span_days", doc });
  }
  {
    const doc = clone(full);
    (doc["relationships"] as Array<Record<string, unknown>>)[0]!["archetype"] = null;
    cases.push({ label: "null archetype", doc });
  }
  {
    const doc = clone(full);
    (doc["corpus"] as Record<string, unknown>)["health_reasons"] = ["not_a_reason"];
    cases.push({ label: "unknown health_reason", doc });
  }
  {
    const doc = clone(full);
    delete doc["whole_life"];
    cases.push({ label: "no whole_life", doc });
  }
  return cases;
}

/**
 * digest.v2 was never differentially tested — `compile()` was only ever handed
 * `digest.v1.json`. That is how the v2 mirror came to omit `unknown` from both
 * `understanding.register` and `understanding.relationship_kind` while the frozen
 * schema listed it, and how a real 420-relationship digest earned 554 validation
 * errors for values the arbiter calls valid.
 *
 * The enum probe below is driven BY the frozen schema rather than by a hand-written
 * list, so a member added to `digest.v2.json` is covered without editing this file.
 */
function digestV2Cases(): Array<{ label: string; doc: unknown }> {
  const full = load("digest_v2", "understood.json");
  const cases: Array<{ label: string; doc: unknown }> = [{ label: "fixture:understood", doc: full }];

  const schema = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "digest.v2.json"), "utf8"),
  ) as Record<string, any>;
  const understanding = schema["$defs"]["understanding"]["properties"] as Record<string, any>;
  const exemplar = schema["$defs"]["contextual_exemplar"]["properties"] as Record<string, any>;

  // Every member the frozen schema permits, plus one it does not, in every enum field.
  // A member the mirror is missing shows up as ajv VALID / zod invalid.
  for (const [field, spec] of Object.entries(understanding)) {
    if (!Array.isArray(spec["enum"])) continue;
    for (const member of [...spec["enum"], "not_a_member"]) {
      const doc = clone(full);
      const rel = (doc["relationships"] as Array<Record<string, any>>)[0]!;
      rel["understanding"][field] = member;
      cases.push({ label: `understanding.${field} = ${member}`, doc });
    }
  }
  for (const [field, spec] of Object.entries(exemplar)) {
    if (!Array.isArray(spec["enum"])) continue;
    for (const member of [...spec["enum"], "not_a_member"]) {
      const doc = clone(full);
      const rel = (doc["relationships"] as Array<Record<string, any>>)[0]!;
      const exemplars = rel["understanding"]["voice_exemplars"] as Array<Record<string, unknown>>;
      if (exemplars.length === 0) continue;
      exemplars[0]![field] = member;
      cases.push({ label: `voice_exemplars[0].${field} = ${member}`, doc });
    }
  }

  // Required/optional and junk-key axes, the two the v1 differential already covers.
  const rel0 = (full["relationships"] as Array<Record<string, unknown>>)[0] ?? {};
  for (const key of Object.keys(rel0)) {
    const doc = clone(full);
    delete (doc["relationships"] as Array<Record<string, unknown>>)[0]![key];
    cases.push({ label: `relationship without ${key}`, doc });
  }
  for (const key of Object.keys((rel0["understanding"] as Record<string, unknown>) ?? {})) {
    const doc = clone(full);
    delete ((doc["relationships"] as Array<Record<string, any>>)[0]!["understanding"] as Record<string, unknown>)[key];
    cases.push({ label: `understanding without ${key}`, doc });
  }
  for (const key of Object.keys(full)) {
    const doc = clone(full);
    delete doc[key];
    cases.push({ label: `without ${key}`, doc });
  }
  {
    const doc = clone(full);
    (doc["relationships"] as Array<Record<string, any>>)[0]!["understanding"]["totally_unexpected"] = 1;
    cases.push({ label: "junk key in understanding", doc });
  }
  return cases;
}

function voicePackCases(): Array<{ label: string; doc: unknown }> {
  const full = load("voice_pack", "maya.json");
  const cases: Array<{ label: string; doc: unknown }> = [
    { label: "fixture:maya", doc: full },
    { label: "fixture:global", doc: load("voice_pack", "global_fallback.json") },
  ];
  for (const key of Object.keys(full)) {
    const doc = clone(full);
    delete doc[key];
    cases.push({ label: `without ${key}`, doc });
  }
  const register = full["register"] as Record<string, unknown>;
  for (const key of Object.keys(register)) {
    const doc = clone(full);
    delete (doc["register"] as Record<string, unknown>)[key];
    cases.push({ label: `register without ${key}`, doc });
  }
  {
    const doc = clone(full);
    doc["totally_unexpected"] = 1;
    cases.push({ label: "junk key", doc });
  }
  {
    const doc = clone(full);
    doc["exemplars"] = [];
    cases.push({ label: "no exemplars", doc });
  }
  return cases;
}

/**
 * chat_reply.v2's new axis versus v1: `kind = "open"` requires `evidence` and forbids
 * non-empty `licenses`; `answer`/`decline` forbid `evidence` entirely. This is exactly the
 * kind of conditional (if/then/else on a sibling field) that a hand-written zod `.refine()`
 * can silently diverge from the frozen schema's `allOf`/`if`/`then`/`else` — the enum-drift
 * bug this whole file exists to catch, on a different axis (a conditional requirement
 * instead of a missing enum member).
 */
function chatReplyV2Cases(): Array<{ label: string; doc: unknown }> {
  const answer = load("chat_reply_v2", "answer.json");
  const open = load("chat_reply_v2", "open.json");
  const decline = load("chat_reply_v2", "decline.json");
  const cases: Array<{ label: string; doc: unknown }> = [
    { label: "fixture:answer", doc: answer },
    { label: "fixture:open", doc: open },
    { label: "fixture:decline", doc: decline },
  ];

  for (const key of Object.keys(answer)) {
    const doc = clone(answer);
    delete (doc as Record<string, unknown>)[key];
    cases.push({ label: `answer without ${key}`, doc });
  }
  for (const key of Object.keys(open)) {
    const doc = clone(open);
    delete (doc as Record<string, unknown>)[key];
    cases.push({ label: `open without ${key}`, doc });
  }

  // The kind=open conditional, both directions.
  {
    const doc = clone(open) as Record<string, unknown>;
    delete doc["evidence"];
    cases.push({ label: "open without evidence (should be invalid: evidence required)", doc });
  }
  {
    const doc = clone(open) as Record<string, unknown>;
    doc["licenses"] = [{ contact_id: "h_8f21a4c0", display: "Maya", reason: "x" }];
    cases.push({ label: "open with non-empty licenses (should be invalid)", doc });
  }
  {
    const doc = clone(open) as Record<string, unknown>;
    doc["evidence"] = [];
    cases.push({ label: "open with empty evidence array (should be valid — key present)", doc });
  }
  {
    const doc = clone(answer) as Record<string, unknown>;
    doc["evidence"] = [{ source: "relationship", id: "p_maya01" }];
    cases.push({ label: "answer with evidence present (should be invalid: evidence forbidden)", doc });
  }
  {
    const doc = clone(decline) as Record<string, unknown>;
    doc["evidence"] = [];
    cases.push({ label: "decline with empty evidence array (should be invalid: key must be absent)", doc });
  }
  {
    const doc = clone(answer) as Record<string, unknown>;
    doc["kind"] = "maybe";
    cases.push({ label: "unrecognized kind", doc });
  }
  {
    const doc = clone(open) as Record<string, unknown>;
    (doc["evidence"] as Array<Record<string, unknown>>).push({ source: "open_loop" }); // missing id
    cases.push({ label: "evidence ref missing id", doc });
  }
  {
    const doc = clone(answer) as Record<string, unknown>;
    doc["totally_unexpected"] = 1;
    cases.push({ label: "junk key in root", doc });
  }
  {
    const doc = clone(answer) as Record<string, unknown>;
    doc["follow_up_draft"] = { schema_version: "draft_delivery.v1", contact_id: "h_8f21a4c0", text: "sounds good", recipient: { kind: "resolved", handle: "+15550001234" } };
    cases.push({ label: "answer with resolved follow_up_draft", doc });
  }
  {
    const doc = clone(answer) as Record<string, unknown>;
    doc["follow_up_draft"] = { schema_version: "draft_delivery.v1", contact_id: "h_8f21a4c0", text: "sounds good", recipient: { kind: "resolved" } }; // missing handle
    cases.push({ label: "follow_up_draft resolved recipient missing handle", doc });
  }
  return cases;
}

/** chat_route.v1's ONLY conditional: `intent` present iff `lane = cache_hit`. `lane` and
 * `intent` are deliberately distinct concepts (router outcome vs. §4.2a cache key) — these
 * cases probe that they cannot be swapped or conflated without the frozen schema noticing. */
function chatRouteCases(): Array<{ label: string; doc: unknown }> {
  const cacheHit = load("chat_route", "cache_hit.json");
  const agent = load("chat_route", "agent.json");
  const refuse = load("chat_route", "refuse.json");
  const cases: Array<{ label: string; doc: unknown }> = [
    { label: "fixture:cache_hit", doc: cacheHit },
    { label: "fixture:agent", doc: agent },
    { label: "fixture:refuse", doc: refuse },
  ];

  for (const intent of ["waiting_on_me", "drifting", "overdue", "morning_brief"]) {
    const doc = clone(cacheHit) as Record<string, unknown>;
    doc["intent"] = intent;
    cases.push({ label: `cache_hit with intent=${intent}`, doc });
  }
  {
    const doc = clone(cacheHit) as Record<string, unknown>;
    doc["intent"] = "not_a_real_intent";
    cases.push({ label: "cache_hit with unrecognized intent (should be invalid)", doc });
  }
  {
    const doc = clone(cacheHit) as Record<string, unknown>;
    delete doc["intent"];
    cases.push({ label: "cache_hit without intent (should be invalid: intent required)", doc });
  }
  {
    const doc = clone(agent) as Record<string, unknown>;
    doc["intent"] = "waiting_on_me";
    cases.push({ label: "agent with intent present (should be invalid: intent forbidden)", doc });
  }
  {
    const doc = clone(refuse) as Record<string, unknown>;
    doc["intent"] = "waiting_on_me";
    cases.push({ label: "refuse with intent present (should be invalid: intent forbidden)", doc });
  }
  {
    const doc = clone(agent) as Record<string, unknown>;
    doc["lane"] = "not_a_real_lane";
    cases.push({ label: "unrecognized lane", doc });
  }
  {
    const doc = clone(agent) as Record<string, unknown>;
    delete doc["lane"];
    cases.push({ label: "missing lane", doc });
  }
  {
    const doc = clone(agent) as Record<string, unknown>;
    doc["totally_unexpected"] = 1;
    cases.push({ label: "junk key", doc });
  }
  return cases;
}

/**
 * `messages_access_state` — the field that once could not reach the cloud at all,
 * because the OLD inline heartbeat schema in `boi-api.v1.yaml` set
 * `additionalProperties: false` with no room for it, and every real heartbeat that
 * carried it got a 400. Additive and optional is the whole fix, so the cases below
 * probe exactly that: present with every value the frozen schema allows, present with
 * one it does not, and — the case that proves "optional" rather than merely "not yet
 * required" — absent entirely, same as every heartbeat sent before this field existed.
 *
 * The enum is read from the frozen schema itself, same reasoning as `digestV2Cases`:
 * a member added to `heartbeat.v1.json` is covered here without editing this file.
 */
const BASE_HEARTBEAT = {
  device_id: "dev_abcdefgh",
  app_version: "0.1.0",
  digest_as_of: "2026-08-01T09:14:00Z",
} as const;

function heartbeatCases(): Array<{ label: string; doc: unknown }> {
  const cases: Array<{ label: string; doc: unknown }> = [
    { label: "minimal", doc: BASE_HEARTBEAT },
    { label: "null digest_as_of", doc: { ...BASE_HEARTBEAT, digest_as_of: null } },
    {
      label: "fully populated",
      doc: { ...BASE_HEARTBEAT, macos_version: "26.0", fda_granted: true, messages_access_state: "ok" },
    },
  ];

  // Required-key removal: each of the three required keys, dropped in turn, must be
  // invalid in BOTH validators.
  for (const key of Object.keys(BASE_HEARTBEAT)) {
    const doc = clone(BASE_HEARTBEAT) as Record<string, unknown>;
    delete doc[key];
    cases.push({ label: `without ${key}`, doc });
  }

  // Every member the frozen schema permits for messages_access_state, plus one it does
  // not. A member the zod mirror is missing shows up as ajv VALID / zod invalid; a
  // member the zod mirror over-accepts shows up the other way.
  const schema = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "heartbeat.v1.json"), "utf8"),
  ) as { properties: Record<string, { enum?: string[] }> };
  const stateEnum = schema.properties["messages_access_state"]?.enum ?? [];
  for (const member of [...stateEnum, "not_a_member"]) {
    cases.push({
      label: `messages_access_state = ${member}`,
      doc: { ...BASE_HEARTBEAT, messages_access_state: member },
    });
  }

  // Absent entirely — the axis that proves optional, not just "not required yet". Every
  // case above except this one carries the key; this is the pre-existing-Mac shape.
  cases.push({ label: "no messages_access_state key", doc: { ...BASE_HEARTBEAT } });

  // Junk key at the root — `additionalProperties: false` is what made this field
  // impossible to add without a schema change in the first place, so the differential
  // must keep proving it still holds.
  cases.push({ label: "junk key", doc: { ...BASE_HEARTBEAT, totally_unexpected: 1 } });

  return cases;
}

function differential(
  name: string,
  zod: ZodType<unknown>,
  validate: ValidateFunction,
  cases: Array<{ label: string; doc: unknown }>,
): void {
  const disagreements: string[] = [];
  for (const { label, doc } of cases) {
    const byAjv = validate(doc) as boolean;
    const byZod = zod.safeParse(doc).success;
    if (byAjv !== byZod) {
      disagreements.push(
        `${name} ${label}: frozen schema says ${byAjv ? "VALID" : "invalid"}, ` +
          `zod says ${byZod ? "VALID" : "invalid"}`,
      );
    }
  }
  expect(disagreements).toEqual([]);
}

describe("the zod mirror agrees with the frozen JSON Schema, decision for decision", () => {
  it("covers a meaningful number of boundary documents", () => {
    // Guards against the differential passing because the case list is empty.
    expect(digestCases().length).toBeGreaterThan(30);
    expect(digestV2Cases().length).toBeGreaterThan(30);
    expect(voicePackCases().length).toBeGreaterThan(15);
    expect(chatReplyV2Cases().length).toBeGreaterThan(10);
    expect(chatRouteCases().length).toBeGreaterThan(8);
    expect(heartbeatCases().length).toBeGreaterThan(5);
  });

  it("agrees on every digest case", () => {
    differential("digest", digestSchema, compile("digest.v1.json"), digestCases());
  });

  it("agrees on every digest v2 case", () => {
    differential("digest.v2", digestSchema, compile("digest.v2.json"), digestV2Cases());
  });

  it("agrees on every voice pack case", () => {
    differential("voice_pack", voicePackSchema, compile("voice_pack.v1.json"), voicePackCases());
  });

  it("agrees on every chat_reply.v2 case, including the kind=open conditional", () => {
    differential("chat_reply.v2", chatReplyV2Schema, compile("chat_reply.v2.json"), chatReplyV2Cases());
  });

  /**
   * The gap that let chat_reply.v2 land fully schema/zod-validated while being
   * unreachable from any runtime type (Track H integration finding, 2026-08-09): this
   * file's differential only ever checked zod against ajv. Nothing checked ADOPTION —
   * whether `cloud/shared/src/contracts.ts`'s runtime type could express what the schema
   * and the zod mirror already agreed on. `schemas.ts` now asserts, at compile time, that
   * its `ChatReplyV2` is bidirectionally equal to `z.infer<typeof chatReplyV2Schema>`
   * (search that file for "Compile-time guard"); this is the runtime companion — every
   * fixture already covered above, round-tripped through a value actually typed as the
   * SHARED type and re-validated by the same zod schema, so a regression here fails a
   * test rather than only failing `tsc` on a line nobody is looking at.
   */
  it("cloud/shared/src/contracts.ts's ChatReplyV2 is not orphaned — fixtures typed as the shared type still validate against chatReplyV2Schema", () => {
    const openFixture = load("chat_reply_v2", "open.json") as unknown as ChatReplyV2;
    const answerFixture = load("chat_reply_v2", "answer.json") as unknown as ChatReplyV2;
    const declineFixture = load("chat_reply_v2", "decline.json") as unknown as ChatReplyV2;
    for (const [label, fixture] of [
      ["open", openFixture],
      ["answer", answerFixture],
      ["decline", declineFixture],
    ] as const) {
      const result = chatReplyV2Schema.safeParse(fixture);
      const issues = result.success ? null : result.error.issues;
      expect(result.success, `${label}: ${JSON.stringify(issues)}`).toBe(true);
    }
    // The open fixture is the one that actually exercises kind="open" — assert its
    // evidence made the round trip through the shared type, not just its presence.
    expect(openFixture.kind).toBe("open");
    expect(openFixture.evidence).toBeDefined();
    expect(openFixture.evidence!.length).toBeGreaterThan(0);
  });

  it("agrees on every chat_route.v1 case, including the lane/intent conditional", () => {
    differential("chat_route.v1", chatRouteV1Schema, compile("chat_route.v1.json"), chatRouteCases());
  });

  it("agrees on every heartbeat case", () => {
    differential("heartbeat", heartbeatSchema, compile("heartbeat.v1.json"), heartbeatCases());
  });

  it("would notice a disagreement — the differential is not vacuous", () => {
    // A deliberately wrong mirror must be caught, or the two tests above prove nothing.
    const tooStrict = digestSchema.refine(() => false, { message: "always fails" });
    expect(() =>
      differential("digest", tooStrict, compile("digest.v1.json"), [
        { label: "minimal", doc: MINIMAL_DIGEST },
      ]),
    ).toThrow();
  });

  it("the minimal digest really is minimal, and the frozen schema accepts it", () => {
    const validate = compile("digest.v1.json");
    expect(validate(MINIMAL_DIGEST), JSON.stringify(validate.errors)).toBe(true);

    // Removing any remaining key must make it invalid — otherwise "minimal" is a
    // document that still carries optional fields and proves less than it claims.
    for (const key of Object.keys(MINIMAL_DIGEST)) {
      const doc = clone(MINIMAL_DIGEST) as Record<string, unknown>;
      delete doc[key];
      expect(validate(doc), `${key} turns out to be optional`).toBe(false);
    }
  });
});
