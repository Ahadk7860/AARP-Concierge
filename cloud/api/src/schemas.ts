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

const relationship = z
  .object({
    contact_id: z.string().regex(ID_PATTERNS.contact),
    display: z.string(),
    is_group: z.boolean(),
    message_count: z.number().int().min(0),
    sent_count: z.number().int().min(0),
    received_count: z.number().int().min(0),
    first_contact_at: nullableIso,
    last_contact_at: nullableIso,
    days_since_last_contact: z.number().min(0),
    momentum_90d: z.number().min(0),
    initiation_ratio: z.number().min(0).max(1),
    median_reply_latency_s: z
      .object({ user: z.number().nullable(), them: z.number().nullable() })
      .optional(),
    p90_reply_latency_s: z
      .object({ user: z.number().nullable(), them: z.number().nullable() })
      .optional(),
    tapbacks: z.object({ given: z.number(), received: z.number() }).optional(),
    muted_by_them: z.boolean().nullable().optional(),
    green_share: z.number().min(0).max(1).optional(),
    calls: z
      .object({
        count: z.number(),
        total_seconds: z.number(),
        initiated_by_user: z.number(),
        missed: z.number(),
      })
      .optional(),
    archetype: z
      .enum([
        "fade",
        "chapter",
        "one_way_enthusiasm",
        "the_one_you_keep_waiting",
        "rising_fastest",
      ])
      .nullable(),
    as_of: isoUtc,
  })
  .strict();

export const digestSchema = z
  .object({
    schema_version: z.literal("digest.v1"),
    user_id: z.string().regex(ID_PATTERNS.user),
    device_id: z.string().regex(ID_PATTERNS.device),
    generated_at: isoUtc,
    corpus: z
      .object({
        message_count: z.number().int().min(0),
        thread_count: z.number().int().min(0),
        first_message_at: nullableIso,
        last_message_at: nullableIso,
        span_days: z.number().min(0),
        green_share: z.number().min(0).max(1).optional(),
        messages_in_icloud: z.boolean().nullable().optional(),
        retention_boundary: z
          .enum(["30d", "365d", "1y_exact", "30d_exact"])
          .nullable()
          .optional(),
        days_since_newest: z.number().min(0).optional(),
        health: z.enum(["healthy", "fixable", "thin"]),
        health_reasons: z.array(z.string()).optional(),
        as_of: isoUtc,
      })
      .strict(),
    relationships: z.array(relationship),
    // `whole_life` is deliberately open: digest.v1.json lets Track A add facts to it
    // without a contract change. `as_of` is the one thing that must be there — § 6:
    // as_of on every fact, end to end, structurally impossible to lose.
    whole_life: z.object({ as_of: isoUtc }).passthrough(),
  })
  .strict();

export const voicePackSchema = z
  .object({
    schema_version: z.literal("voice_pack.v1"),
    voice_pack_version: z.string().regex(VOICE_PACK_LIMITS.versionPattern),
    contact_id: z.string().regex(ID_PATTERNS.contact).nullable(),
    scope: z.enum(["contact", "global"]),
    n_exemplars: z.number().int().min(0).max(VOICE_PACK_LIMITS.maxExemplars).optional(),
    register: z
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
      .strict(),
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

export const heartbeatSchema = z
  .object({
    device_id: z.string().regex(ID_PATTERNS.device),
    app_version: z.string(),
    digest_as_of: isoUtc,
    macos_version: z.string().optional(),
    fda_granted: z.boolean().optional(),
  })
  .strict();
