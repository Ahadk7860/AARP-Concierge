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
import { digestSchema, voicePackSchema } from "./schemas.js";

const SCHEMA_DIR = join(process.cwd(), "contracts", "schema");
const FIXTURE_DIR = join(process.cwd(), "contracts", "fixtures");

const ajv = new Ajv2020({ strict: false, allErrors: true });
// CONTRACTS.md § 6: ISO 8601 UTC with a Z. ajv-formats' `date-time` would accept
// `+00:00` offsets, which § 6 forbids and the zod mirror rejects — using it here would
// manufacture a disagreement that is not real.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

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
    expect(voicePackCases().length).toBeGreaterThan(15);
  });

  it("agrees on every digest case", () => {
    differential("digest", digestSchema, compile("digest.v1.json"), digestCases());
  });

  it("agrees on every voice pack case", () => {
    differential("voice_pack", voicePackSchema, compile("voice_pack.v1.json"), voicePackCases());
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
