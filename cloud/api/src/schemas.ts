// zod mirrors of the frozen request shapes.
//
// Every bound and pattern that has a number in `contracts/schema/*.json` is read from
// there rather than retyped here — see `contract-limits.ts`. What is hand-written is
// the STRUCTURE, and `schemas.test.ts` cross-checks that against every committed
// fixture plus the JSON Schema's own `additionalProperties: false`.

import { z } from "zod";
import { ID_PATTERNS, VOICE_PACK_LIMITS } from "./contract-limits.js";

/** CONTRACTS.md § 6: ISO 8601 UTC with a `Z`, at every boundary. No epoch integers. */
export const isoUtc = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    "must be an ISO 8601 UTC timestamp ending in Z",
  );

const nullableIso = isoUtc.nullable();

const nullableInt = z.number().int().nullable();

// OPTIONAL vs NULLABLE is the distinction this mirror got wrong the first time.
// `digest.v1.json`'s `$defs/relationship.required` is exactly:
//   contact_id, display, is_group, message_count, sent_count, received_count,
//   days_since_last_contact, momentum_90d, initiation_ratio, as_of
// plus, since AMENDMENT-001: last_from_me, max_gap_days, unanswered_question, facts
// Everything else — including `archetype`, `first_contact_at` and `last_contact_at` —
// may be ABSENT. Marking them `.nullable()` without `.optional()` made this validator
// reject documents the frozen schema calls valid, and no test caught it because every
// committed fixture is fully populated. Track A would have got a 400 for a conforming
// digest. `schemas.test.ts` now differentials this against ajv over the frozen schema.

// AMENDMENT-001. `facts` in a digest is the SAME subschema as `gist.v1.facts`: 3 words,
// 40 characters, per token. The cap is spelled here because this is a hand-written
// mirror, and `differential.test.ts` is what proves the spelling matches the frozen
// schema rather than merely resembling it — a cap enforced in one container and not the
// other is not a cap.
const factToken = z.string().max(40).regex(/^\S+(?:\s+\S+){0,2}$/);
const factList = z.array(factToken);
const facts = z
  .object({
    dates: factList,
    times: factList,
    places: factList,
    amounts: factList,
    names: factList,
  })
  .strict();

const relationship = z
  .object({
    contact_id: z.string().regex(ID_PATTERNS.contact),
    display: z.string().min(1).max(64),
    is_group: z.boolean(),
    message_count: z.number().int().min(0),
    sent_count: z.number().int().min(0),
    received_count: z.number().int().min(0),
    first_contact_at: nullableIso.optional(),
    last_contact_at: nullableIso.optional(),
    days_since_last_contact: z.number().int().min(0),
    momentum_90d: z.number().min(0),
    initiation_ratio: z.number().min(0).max(1),
    // AMENDMENT-001, all four REQUIRED. Optional would mean an un-updated Mac uploads a
    // digest that validates and produces gists that can never be `action_needed` — no
    // error, and a morning brief that quietly stops saying the only thing it exists to
    // say. Required means that Mac is rejected here, loudly, on the first upload.
    last_from_me: z.boolean(),
    max_gap_days: z.number().int().min(0),
    unanswered_question: z.boolean(),
    facts,
    median_reply_latency_s: z
      .object({ user: nullableInt.optional(), them: nullableInt.optional() })
      .strict()
      .optional(),
    p90_reply_latency_s: z
      .object({ user: nullableInt.optional(), them: nullableInt.optional() })
      .strict()
      .optional(),
    tapbacks: z
      .object({ given: z.number().int().optional(), received: z.number().int().optional() })
      .strict()
      .optional(),
    muted_by_them: z.boolean().nullable().optional(),
    green_share: z.number().min(0).max(1).optional(),
    calls: z
      .object({
        count: z.number().int().optional(),
        total_seconds: z.number().int().optional(),
        initiated_by_user: z.number().int().optional(),
        missed: z.number().int().optional(),
      })
      .strict()
      .optional(),
    archetype: z
      .enum([
        "fade",
        "chapter",
        "one_way_enthusiasm",
        "the_one_you_keep_waiting",
        "rising_fastest",
      ])
      .nullable()
      .optional(),
    as_of: isoUtc,
  })
  .strict();

const corpusSchema = z
  .object({
    message_count: z.number().int().min(0),
    thread_count: z.number().int().min(0),
    first_message_at: nullableIso.optional(),
    last_message_at: nullableIso.optional(),
    span_days: z.number().int().min(0),
    green_share: z.number().min(0).max(1).optional(),
    messages_in_icloud: z.boolean().nullable().optional(),
    retention_boundary: z
      .enum(["30d", "365d", "1y_exact", "30d_exact"])
      .nullable()
      .optional(),
    days_since_newest: z.number().int().min(0).optional(),
    health: z.enum(["healthy", "fixable", "thin"]),
    health_reasons: z
      .array(
        z.enum([
          "icloud_off",
          "keep_messages_30d",
          "keep_messages_1y",
          "new_mac",
          "low_green_share",
          "stale_sync",
          "low_power_mode",
          "none",
        ]),
      )
      .optional(),
    as_of: isoUtc,
  })
  .strict();

const wholeLifeSchema = z
  .object({
    total_messages: z.number().int().optional(),
    unique_people: z.number().int().optional(),
    global_median_reply_s: z.number().int().optional(),
    concentration_top1: z.number().optional(),
    concentration_top5: z.number().optional(),
    concentration_top10: z.number().optional(),
    relationships_gone_quiet: z.number().int().optional(),
    relationships_ranked: z.number().int().optional(),
    late_night_share: z.number().optional(),
    as_of: isoUtc,
  })
  .strict();

export const digestV1Schema = z
  .object({
    schema_version: z.literal("digest.v1"),
    user_id: z.string().regex(ID_PATTERNS.user),
    device_id: z.string().regex(ID_PATTERNS.device),
    generated_at: isoUtc,
    // `corpus.required` is only: message_count, thread_count, span_days, health, as_of.
    corpus: corpusSchema,
    relationships: z.array(relationship),
    // NOT open. The previous comment here claimed digest.v1.json lets Track A add keys
    // to `whole_life` without a contract change; it does not — `additionalProperties`
    // is false and the property list is closed. `.passthrough()` made this validator
    // ACCEPT documents the frozen schema rejects, the opposite drift to the one above,
    // and equally invisible against fully-populated fixtures.
    whole_life: wholeLifeSchema,
  })
  .strict();

const contextualExemplarSchema = z
  .object({
    text: z.string().min(1).max(200),
    answered: z.enum(["question_from_them", "statement_from_them", "plan_unresolved", "none"]),
    register: z.enum(["casual", "warm", "terse", "formal", "mixed", "unknown"]),
  })
  .strict();

const understandingSchema = z
  .object({
    // `unknown` is the below-threshold answer, and the frozen `digest.v2.json` lists it
    // in both enums. Omitting it here made this mirror reject documents the arbiter
    // calls valid — 554 of them on a real 420-relationship digest.
    register: z.enum(["casual", "warm", "terse", "formal", "mixed", "unknown"]),
    relationship_kind: z.enum(["close_friend", "logistics", "work", "family", "dormant_close", "other", "unknown"]),
    open_thread: z.string().max(140).nullable(),
    last_exchange_shape: z.enum(["question_from_them", "statement_from_them", "statement_from_you", "plan_unresolved", "none"]),
    topics: z.array(factToken).max(8),
    cadence_norm: z.string().max(140).nullable(),
    voice_exemplars: z.array(contextualExemplarSchema).max(40),
  })
  .strict();

const relationshipV2Schema = z
  .object({
    contact_id: z.string().regex(ID_PATTERNS.contact),
    display: z.string().min(1).max(64),
    is_group: z.boolean(),
    message_count: z.number().int().min(0),
    sent_count: z.number().int().min(0),
    received_count: z.number().int().min(0),
    days_since_last_contact: z.number().int().min(0),
    momentum_90d: z.number().min(0),
    initiation_ratio: z.number().min(0).max(1),
    last_from_me: z.boolean(),
    max_gap_days: z.number().int().min(0),
    unanswered_question: z.boolean(),
    // The frozen v2 contract currently constrains this only to an object.
    facts: z.record(z.unknown()),
    as_of: isoUtc,
    understanding: understandingSchema,
  })
  .strict();

export const digestV2Schema = z
  .object({
    schema_version: z.literal("digest.v2"),
    user_id: z.string().regex(ID_PATTERNS.user),
    device_id: z.string().regex(ID_PATTERNS.device),
    generated_at: isoUtc,
    synced_through: isoUtc,
    corpus: corpusSchema,
    relationships: z.array(relationshipV2Schema),
    whole_life: wholeLifeSchema,
  })
  .strict();

/** The version-discriminated upload boundary. Neither branch accepts the other's fields. */
export const digestSchema = z.discriminatedUnion("schema_version", [digestV1Schema, digestV2Schema]);

const registerSchema = z
  .object({
    median_len_chars: z.number().int().min(1),
    p90_len_chars: z.number().int().min(1).optional(),
    emoji_rate: z.number().min(0).max(1),
    top_emoji: z.array(z.string()).max(5).optional(),
    punctuation: z.enum([
      "lowercase_no_period",
      "lowercase_period",
      "sentence_case_no_period",
      "sentence_case_period",
      "mixed",
    ]),
    greeting_rate: z.number().min(0).max(1).optional(),
    signoff_rate: z.number().min(0).max(1).optional(),
    abbreviations: z.array(z.string()).max(20).optional(),
    avg_msgs_per_burst: z.number().min(1),
    question_rate: z.number().min(0).max(1).optional(),
    apology_openers: z.array(z.string()).max(5).optional(),
  })
  .strict();

export const voicePackV1Schema = z
  .object({
    schema_version: z.literal("voice_pack.v1"),
    voice_pack_version: z.string().regex(VOICE_PACK_LIMITS.versionPattern),
    contact_id: z.string().regex(ID_PATTERNS.contact).nullable(),
    scope: z.enum(["contact", "global"]),
    n_exemplars: z.number().int().min(0).max(VOICE_PACK_LIMITS.maxExemplars).optional(),
    register: registerSchema,
    exemplars: z
      .array(
        z
          .string()
          .min(VOICE_PACK_LIMITS.minExemplarChars)
          .max(VOICE_PACK_LIMITS.maxExemplarChars),
      )
      .max(VOICE_PACK_LIMITS.maxExemplars),
    as_of: isoUtc,
  })
  .strict()
  // The schema's own `contact_id`/`scope` agreement, which JSON Schema states in prose
  // and the database enforces as `voice_packs_scope_matches_contact`.
  .refine(
    (p) => (p.scope === "global" ? p.contact_id === null : p.contact_id !== null),
    { message: "scope 'global' requires contact_id null; 'contact' requires a contact_id" },
  );

export const voicePackV2Schema = z
  .object({
    schema_version: z.literal("voice_pack.v2"),
    voice_pack_version: z.string().regex(VOICE_PACK_LIMITS.versionPattern),
    contact_id: z.string().regex(ID_PATTERNS.contact).nullable(),
    scope: z.enum(["contact", "global"]),
    n_exemplars: z.number().int().min(0).max(40).optional(),
    register: registerSchema,
    exemplars: z.array(contextualExemplarSchema).max(40),
    as_of: isoUtc,
  })
  .strict()
  .refine(
    (p) => (p.scope === "global" ? p.contact_id === null : p.contact_id !== null),
    { message: "scope 'global' requires contact_id null; 'contact' requires a contact_id" },
  );

/** Union rather than coercion: v1 and v2 remain independently strict. */
export const voicePackSchema = z.union([voicePackV1Schema, voicePackV2Schema]);

export const heartbeatSchema = z
  .object({
    device_id: z.string().regex(ID_PATTERNS.device),
    app_version: z.string(),
    // AMENDMENT-003: required and NULLABLE, never optional. `null` means "this device
    // has never produced a digest", which is a claim; an absent field is a producer that
    // forgot, and those must not be the same thing. `.nullable()` keeps the key
    // mandatory; `.optional()` would not.
    digest_as_of: isoUtc.nullable(),
    macos_version: z.string().optional(),
    fda_granted: z.boolean().optional(),
  })
  .strict();
