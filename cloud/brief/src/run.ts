// One scheduler tick.
//
// Idempotency is the property that matters here. A cron that fires twice — a retry, an
// overlapping tick, a redeploy — must produce one brief and one send per user per
// morning, and it must do so without relying on the cron being well behaved. The
// database enforces it: `briefs` has `unique (user_id, scheduled_for)`, and
// `scheduled_for` is the canonical 08:00-local instant rather than the tick time, so
// two ticks four minutes apart collide on purpose.

import type { Channel, DraftBundle, Gist } from "../../shared/src/index.js";
import {
  briefForSlot,
  getUser,
  insertBrief,
  insertOutboundMessage,
  latestDigest,
  listOutboundMessages,
  listRelationships,
  markBriefDelivery,
  markOutboundSent,
  newBriefId,
  newOutboundMessageId,
  sentIdempotencyKeys,
  unsafeScopeFromUserId,
  type UserScope,
} from "../../db/src/index.js";
import { composeBrief } from "./compose.js";
import { deliverBrief } from "./deliver.js";
import { nextRetry, slotFor, type UserSchedule } from "./scheduler.js";

export type TickOutcome =
  | { user_id: string; status: "sent"; brief_id: string; items: number; messages: number }
  | { user_id: string; status: "already_sent"; brief_id: string }
  | {
      user_id: string;
      status: "skipped";
      reason: "digest_too_stale" | "nothing_to_say" | "no_digest" | "already_settled";
    }
  | { user_id: string; status: "failed"; attempt: number; next_attempt_at: string | null };

export type TickDeps = {
  now: Date;
  channel: Channel;
  /**
   * Track B produces these, and until Track E prompt `02` nothing ever called it: this
   * comment used to read "this track consumes fixtures", which was an honest
   * description of a hole. `cloud/intelligence-bridge` fills it by invoking
   * `boi_intel` in a subprocess — see `tickDeps` below.
   *
   * They stay injected rather than imported here. The composer must not know whether a
   * gist came from a model, from SQL, or from nothing at all, and a brief has to remain
   * testable without a Python interpreter.
   *
   * **`draftsFor` is keyed on `gist_id`**, which `compose.ts` relies on
   * (`input.drafts.get(gist.gist_id)`).
   */
  gistsFor: (scope: UserScope) => Promise<Gist[]>;
  draftsFor: (scope: UserScope) => Promise<Map<string, DraftBundle>>;
  /**
   * The 9:16 card, or `null`.
   *
   * `composeBrief` has accepted `card_url` since Track D built it and every caller
   * passed `null` — `cloud/card/` renders beautifully and had only ever been called by
   * its own tests. This is the edge.
   *
   * **A renderer that is down produces a brief WITHOUT a card, never no brief.** The
   * card is the acquisition loop; the brief is the product. Returning `null` here is a
   * degraded morning, and throwing is a missing one.
   */
  cardUrlFor?: (scope: UserScope, digest: unknown) => Promise<string | null>;
  log?: (event: Record<string, unknown>) => void;
  attempt?: number;
};

/**
 * The production `TickDeps`, and the only place the brief meets the intelligence.
 *
 * There was no construction site before this: `TickDeps` was declared here and built
 * only inside tests, which is precisely why gap 2 survived four merged tracks and a
 * thousand green tests. A type with no producer cannot be wrong.
 *
 * The bridge is passed in rather than imported so this module keeps no dependency on a
 * Python toolchain — `cloud/brief`'s own suite still runs with fixtures, and the wiring
 * is the caller's choice.
 */
export function tickDeps(
  bridge: Pick<TickDeps, "gistsFor" | "draftsFor">,
  rest: Omit<TickDeps, "gistsFor" | "draftsFor">,
): TickDeps {
  return { ...rest, gistsFor: bridge.gistsFor, draftsFor: bridge.draftsFor };
}

export async function runForUser(
  schedule: UserSchedule,
  deps: TickDeps,
): Promise<TickOutcome> {
  const log = deps.log ?? (() => {});
  const scope = unsafeScopeFromUserId(schedule.user_id);
  const scheduledFor = slotFor(deps.now, schedule.timezone);

  // THE IDEMPOTENCY CHECK, gated on WHAT HAPPENED rather than on the row existing.
  //
  // This used to short-circuit on the row alone. The row is written before the send and
  // survives a throw, so a failed morning looked identical to a delivered one and the
  // bounded retry could never fire — a 503 at 08:00 meant no brief that day, silently.
  // Only a terminal state stops a retry now; `pending` means the send did not finish
  // and this attempt resumes it.
  const existing = await briefForSlot(scope, scheduledFor);
  if (existing !== null && existing.delivery_status !== "pending") {
    log({
      msg: "brief.already_settled",
      user_id: scope.user_id,
      brief_id: existing.brief_id,
      delivery_status: existing.delivery_status,
    });
    return existing.delivery_status === "sent"
      ? { user_id: scope.user_id, status: "already_sent", brief_id: existing.brief_id }
      : { user_id: scope.user_id, status: "skipped", reason: "already_settled" };
  }
  const resuming = existing !== null;

  if (resuming) {
    log({
      msg: "brief.resuming",
      user_id: scope.user_id,
      brief_id: existing.brief_id,
      attempts: existing.attempts,
    });
  }

  const digest = await latestDigest(scope);
  if (digest === null) {
    // No digest at all is not staleness — it is a Mac that has never reported. Saying
    // "your data is old" would be a wrong answer rather than a missing one.
    log({ msg: "brief.no_digest", user_id: scope.user_id });
    return { user_id: scope.user_id, status: "skipped", reason: "no_digest" };
  }

  const user = await getUser(scope);
  const relationships = (await listRelationships(scope)).map((r) => r.payload);

  const { brief, decision } = composeBrief({
    user_id: scope.user_id,
    scheduled_for: scheduledFor,
    now: deps.now,
    timezone: user?.timezone ?? schedule.timezone,
    digest_as_of: digest.as_of,
    relationships,
    gists: await deps.gistsFor(scope),
    drafts: await deps.draftsFor(scope),
    // The card. `cardUrlFor` swallows a renderer failure and returns null, so a card
    // that cannot be rendered costs the card and not the brief.
    card_url: deps.cardUrlFor ? await deps.cardUrlFor(scope, digest.payload) : null,
  });

  // Reuse the row on a resumed attempt: `unique (user_id, scheduled_for)` would reject
  // a second insert, and a second brief_id would orphan the messages already sent.
  const briefId = existing?.brief_id ?? newBriefId();

  // Persisted BEFORE the send, including when it will be skipped. The skip is a record,
  // not just a log line: a user asking "why didn't I get one" deserves an answer that
  // outlives the log retention window.
  if (!resuming) await insertBrief(scope, { brief_id: briefId, brief });

  // What already went out on a previous attempt, so a resume does not re-send it.
  const alreadySent = resuming ? await sentIdempotencyKeys(scope, briefId) : new Set<string>();
  const leadKey = `brief-${brief.user_id}-${brief.scheduled_for}-lead`;
  let leadProviderMessageId: string | null = null;
  if (alreadySent.has(leadKey)) {
    const rows = await listOutboundMessages(scope);
    leadProviderMessageId =
      rows.find((r) => r.idempotency_key === leadKey)?.provider_message_id ?? null;
  }

  let result;
  try {
    result = await deliverBrief({
      brief,
      channel: deps.channel,
      skip: decision,
      log,
      alreadySent,
      leadProviderMessageId,
      // THE MAPPING, written per send rather than after the loop. If message three
      // throws, one and two are already out in the world and their provider ids must
      // survive the throw — that is what a resume reads.
      onSent: async ({ message, result: sendResult, item_index }) => {
        await insertOutboundMessage(scope, {
          message_id: newOutboundMessageId(),
          idempotency_key: message.idempotency_key,
          brief_id: briefId,
          item_index,
          blocks: message.blocks,
        });
        await markOutboundSent(scope, message.idempotency_key, {
          protocol: sendResult.protocol,
          provider: sendResult.provider,
          provider_message_id: sendResult.message_id,
          line_id: sendResult.line_id,
        });
      },
    });
  } catch (err) {
    // Leave the row `pending` so the next attempt resumes rather than reporting success.
    await markBriefDelivery(scope, briefId, {
      status: "pending",
      error: err instanceof Error ? err.message : "unknown",
    });
    throw err;
  }

  if (!result.sent) {
    // Terminal: too stale or nothing to say. Neither improves by trying again.
    await markBriefDelivery(scope, briefId, { status: "skipped", error: result.reason });
    log({
      msg: "brief.not_sent",
      user_id: scope.user_id,
      brief_id: briefId,
      reason: result.reason,
      hours_stale: brief.staleness.hours_stale,
    });
    return { user_id: scope.user_id, status: "skipped", reason: result.reason };
  }

  await markBriefDelivery(scope, briefId, { status: "sent", delivered_at: deps.now });

  return {
    user_id: scope.user_id,
    status: "sent",
    brief_id: briefId,
    items: brief.items.length,
    messages: result.messages.length,
  };
}

/**
 * Run one tick with a bounded retry.
 *
 * A throw from the channel is one failure, logged, with a NEXT ATTEMPT TIME — never a
 * loop. `nextRetry` caps at `MAX_SEND_ATTEMPTS`; past that the outcome is `failed` with
 * `next_attempt_at: null` and nothing calls back.
 */
export async function runForUserWithRetry(
  schedule: UserSchedule,
  deps: TickDeps,
): Promise<TickOutcome> {
  const log = deps.log ?? (() => {});
  const attempt = deps.attempt ?? 0;
  try {
    return await runForUser(schedule, deps);
  } catch (err) {
    const retry = nextRetry(attempt, deps.now);
    log({
      msg: retry.exhausted ? "brief.send_exhausted" : "brief.send_failed",
      user_id: schedule.user_id,
      attempt: retry.attempt,
      next_attempt_at: retry.next_attempt_at,
      error: err instanceof Error ? err.message : "unknown",
    });
    return {
      user_id: schedule.user_id,
      status: "failed",
      attempt: retry.attempt,
      next_attempt_at: retry.next_attempt_at,
    };
  }
}
