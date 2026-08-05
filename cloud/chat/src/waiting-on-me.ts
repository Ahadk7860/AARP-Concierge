// The first-release chat surface is deliberately a closed query, not a general
// relationship search.  Keep the projection here small: the reply composer may only
// make claims from these rows, and therefore cannot see a complete digest (or a
// voice exemplar) by accident.

import type { ChatQuery, DigestV2 } from "../../shared/src/contracts.js";

export const MIN_WAITING_ON_ME_RESULTS = 1;
export const MAX_WAITING_ON_ME_RESULTS = 3;

/** A single claim the reply layer is allowed to make about one relationship. */
export type WaitingOnMeEvidenceRow = {
  contact_id: string;
  display: string;
  /** On-device-derived description, never counterparty message text. */
  open_thread: string;
};

/**
 * The complete input to a reply composer for `waiting_on_me`.
 *
 * It intentionally has neither a digest nor a relationship object. In particular,
 * raw handles are not in a digest and contextual voice exemplars are not projected
 * here. A composer which receives this result cannot accidentally use either.
 */
export type WaitingOnMeResult = {
  name: "waiting_on_me";
  synced_through: string;
  rows: WaitingOnMeEvidenceRow[];
};

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_WAITING_ON_ME_RESULTS;
  return Math.min(MAX_WAITING_ON_ME_RESULTS, Math.max(MIN_WAITING_ON_ME_RESULTS, Math.trunc(limit)));
}

/**
 * Execute the one Phase 2 chat query.
 *
 * A relationship qualifies only when the Mac-derived final turn says the other
 * person asked a question AND there is a non-empty derived open-thread description.
 * Ranking is intentionally mechanical: older outstanding conversations first, then
 * `contact_id` as a stable tie-breaker. Nothing from one relationship is read while
 * constructing another relationship's evidence row.
 */
export function executeWaitingOnMe(digest: DigestV2, query: ChatQuery): WaitingOnMeResult {
  if (query.schema_version !== "chat_query.v1" || query.name !== "waiting_on_me") {
    throw new Error("unsupported chat query");
  }

  const rows = digest.relationships
    .filter((relationship) =>
      relationship.understanding.last_exchange_shape === "question_from_them"
      && relationship.understanding.open_thread !== null
      && relationship.understanding.open_thread.trim().length > 0,
    )
    .sort((left, right) =>
      right.days_since_last_contact - left.days_since_last_contact
      || left.contact_id.localeCompare(right.contact_id),
    )
    .slice(0, boundedLimit(query.limit))
    .map((relationship): WaitingOnMeEvidenceRow => ({
      contact_id: relationship.contact_id,
      display: relationship.display,
      open_thread: relationship.understanding.open_thread as string,
    }));

  return { name: "waiting_on_me", synced_through: digest.synced_through, rows };
}
