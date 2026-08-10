// Derives the v3 person-centric model from an ingested digest.
//
// ORPHANED PIPELINE FIX: repository-v3.ts's write functions (upsertPerson,
// upsertIdentity, insertInteractions, insertDailyMetrics, ...) had zero non-test
// callers — the v3 tables `PostgresAgentStore` (cloud/agent/src/postgres-agent-store.ts)
// reads were always empty, so `relationship_state`/`open_loops`/`drifting`/`circle`
// degraded on every call. This file is the missing producer: it runs after
// `insertDigest` (see ingest-worker.ts) and turns the digest's `contact_id`-keyed
// relationships into `person_id`-keyed rows.
//
// V3_ARCHITECTURE.md §4.1: "For v3, iMessage is the only source: one identity per
// person" — so each non-group relationship becomes exactly one `persons` row plus one
// `identities` row with `source='imessage'`. Group threads (`is_group: true`) are not a
// single human and are skipped here for person/identity/interaction/metric derivation,
// matching the existing `!is_group` guard already used in `cloud/chat/src/waiting-on-me.ts`
// and `cloud/chat/src/draft.ts`.
//
// person_id DISCIPLINE: "'p_' + salted hash, same discipline as contact_id" (task
// spec). `contact_id` is already `h_<hmac-hex>` — a per-user-salted hash of the
// normalized handle, computed on the Mac (ids.ts). Reusing that hash under a different
// prefix keeps the determinism idempotency requires (the same contact always derives
// the same person_id across every digest it appears in) without minting a second
// salted hash for the same handle.
//
// relationship_kind: HAS NO V3 COLUMN. STATE_V2.md §6 ("`lifecycle_stage` and
// `relationship_kind` have no v3 column") and postgres-agent-store.ts's header record
// this as an open, known gap — Track E never added a column for it to `persons` or
// `relationship_metrics_daily`, and this task's constraints forbid adding one now (no
// new migrations). Rather than silently discard it (the bug this task exists to fix)
// it is carried into `interactions.meta.relationship_kind`, the one jsonb column the
// v3 schema exposes at the person level. Logged as a gap in INTERFACES.md. Whoever adds
// the real column later should backfill from there, not fabricate a value.
//
// FAILURE MODE — deliberately NOT the same transaction as `insertDigest`. See
// ingest-worker.ts's call site: `insertDigest`'s transaction is the durability boundary
// for the digest itself (the Mac's data must never be lost); derivation is best-effort
// projection into a cache the agent path reads. If derivation throws, the caller logs
// and swallows it — the digest is already safely committed either way, and the next
// digest naturally re-derives current state. Coupling the two transactions would mean
// a bug in this file (new, less exercised code) could roll back a successful digest
// ingest, which is a strictly worse failure mode than a stale v3 cache.

import { createHash } from "node:crypto";
import pg from "pg";
import { getPool, withTransaction, type Queryable } from "./pool.js";
import type { UserScope } from "./scope.js";
import { newIdentityId } from "./ids.js";
import { upsertPerson, upsertIdentity, insertInteractions, insertDailyMetrics } from "./repository-v3.js";
import type { Digest, DigestV2, Relationship, RelationshipUnderstanding } from "../../shared/src/contracts.js";

const CONTACT_ID_PATTERN = /^h_[0-9a-f]+$/;

/**
 * person_id reuses contact_id's already-salted hash under the 'p_' prefix — see file
 * header. Deterministic so the same iMessage contact always maps to the same person
 * across every digest, which is what makes `upsertPerson`'s `on conflict` idempotent
 * rather than merely non-erroring.
 */
export function personIdForContact(contact_id: string): string {
  if (!CONTACT_ID_PATTERN.test(contact_id)) {
    // Never interpolate the raw value beyond this — it may not be a hash at all.
    throw new Error("derive_v3_unexpected_contact_id_shape");
  }
  return `p_${contact_id.slice(2)}`;
}

/**
 * Deterministic per (digest_id, person_id) so re-deriving the same digest (e.g. a
 * worker retry after a mid-derivation crash) inserts the same interaction_id and the
 * `on conflict (user_id, interaction_id) do nothing` in insertInteractions makes the
 * re-run a no-op instead of a duplicate.
 */
function deterministicInteractionId(digest_id: string, person_id: string): string {
  const digest = createHash("sha256").update(`${digest_id}:${person_id}`).digest("hex");
  return `ia_${digest.slice(0, 32)}`;
}

type RelationshipWithOptionalUnderstanding = Relationship & { understanding?: RelationshipUnderstanding };

function understandingOf(r: RelationshipWithOptionalUnderstanding): RelationshipUnderstanding | null {
  return r.understanding ?? null;
}

export type DerivationCounts = { persons: number; identities: number; interactions: number; metrics: number };

/**
 * Project one digest's non-group relationships into the v3 person-centric tables:
 * persons, identities, interactions, relationship_metrics_daily.
 *
 * Idempotent as a whole: person_id and the identities unique key are derived from the
 * contact_id hash, interaction_id is deterministic per (digest_id, person_id), and
 * relationship_metrics_daily upserts on (user_id, person_id, day) — running this twice
 * for the same digest changes nothing.
 *
 * Does not invent data: fields with no source in the digest (`lifecycle_stage`,
 * `median_gap_days`) are left null rather than guessed. See file header for why
 * `relationship_kind` goes into `interactions.meta` instead of being dropped.
 */
export async function deriveV3FromDigest(
  scope: UserScope,
  input: { digest_id: string; digest: Digest | DigestV2 },
  pool: pg.Pool = getPool(),
): Promise<DerivationCounts> {
  const relationships = (input.digest.relationships as RelationshipWithOptionalUnderstanding[]).filter(
    (r) => !r.is_group,
  );
  // relationship_metrics_daily.day is a `date` column; generated_at is the digest's
  // own timestamp, not "now" — using it keeps repeated ingestion of an old digest from
  // clobbering a newer day's row.
  const day = input.digest.generated_at.slice(0, 10);

  return withTransaction(async (tx: Queryable) => {
    let personsWritten = 0;
    let identitiesWritten = 0;
    const interactionRows: Parameters<typeof insertInteractions>[1] = [];
    const metricRows: Parameters<typeof insertDailyMetrics>[1] = [];

    for (const r of relationships) {
      const person_id = personIdForContact(r.contact_id);
      const understanding = understandingOf(r);

      await upsertPerson(scope, { person_id, display: r.display }, tx);
      personsWritten++;

      await upsertIdentity(
        scope,
        {
          identity_id: newIdentityId(),
          person_id,
          source: "imessage",
          handle: r.contact_id,
          // Exact, not inferred: one iMessage contact_id IS one identity 1:1 for v3
          // (V3_ARCHITECTURE.md §4.1), there is no fuzzy matching happening here.
          confidence: "exact",
          merged_by: null,
          as_of: new Date(r.as_of),
        },
        tx,
      );
      identitiesWritten++;

      if (r.last_contact_at !== null && r.last_contact_at !== undefined) {
        interactionRows.push({
          interaction_id: deterministicInteractionId(input.digest_id, person_id),
          person_id,
          source: "imessage",
          direction: r.sent_count >= r.received_count ? "from_me" : "to_me",
          occurred_at: new Date(r.last_contact_at),
          thread_ref: null,
          // NEVER the content itself — the digest carries none, and this file must
          // not read or log real message content even if it did.
          content_ref: null,
          length: r.message_count,
          meta: {
            digest_id: input.digest_id,
            message_count: r.message_count,
            sent_count: r.sent_count,
            received_count: r.received_count,
            // See file header: no v3 column exists for this yet.
            relationship_kind: understanding?.relationship_kind ?? null,
          },
        });
      }

      metricRows.push({
        person_id,
        day,
        message_count: r.message_count,
        momentum: r.momentum_90d ?? null,
        initiation_ratio: r.initiation_ratio ?? null,
        // No cadence-gap field exists anywhere in the digest — do not invent one.
        median_gap_days: null,
        response_latency_me_min: r.median_reply_latency_s?.user != null
          ? r.median_reply_latency_s.user / 60
          : null,
        response_latency_them_min: r.median_reply_latency_s?.them != null
          ? r.median_reply_latency_s.them / 60
          : null,
        register: understanding?.register ?? null,
      });
    }

    const interactions = await insertInteractions(scope, interactionRows, tx);
    const metrics = await insertDailyMetrics(scope, metricRows, tx);

    return { persons: personsWritten, identities: identitiesWritten, interactions, metrics };
  }, pool);
}
