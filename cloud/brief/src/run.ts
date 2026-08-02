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
  listRelationships,
  markOutboundSent,
  newBriefId,
  newOutboundMessageId,
  unsafeScopeFromUserId,
  type UserScope,
} from "../../db/src/index.js";
import { composeBrief } from "./compose.js";
import { deliverBrief } from "./deliver.js";
import { nextRetry, slotFor, type UserSchedule } from "./scheduler.js";

export type TickOutcome =
  | { user_id: string; status: "sent"; brief_id: string; items: number; messages: number }
  | { user_id: string; status: "already_sent"; brief_id: string }
  | { user_id: string; status: "skipped"; reason: "digest_too_stale" | "nothing_to_say" | "no_digest" }
  | { user_id: string; status: "failed"; attempt: number; next_attempt_at: string | null };

export type TickDeps = {
  now: Date;
  channel: Channel;
  /** Track B produces these. Supplied per user; this track consumes fixtures. */
  gistsFor: (scope: UserScope) => Promise<Gist[]>;
  draftsFor: (scope: UserScope) => Promise<Map<string, DraftBundle>>;
  log?: (event: Record<string, unknown>) => void;
  attempt?: number;
};

export async function runForUser(
  schedule: UserSchedule,
  deps: TickDeps,
): Promise<TickOutcome> {
  const log = deps.log ?? (() => {});
  const scope = unsafeScopeFromUserId(schedule.user_id);
  const scheduledFor = slotFor(deps.now, schedule.timezone);

  // THE IDEMPOTENCY CHECK. Before any work, and keyed on the canonical slot rather than
  // on `now`, so a second tick inside the same window sees the first tick's row.
  const existing = await briefForSlot(scope, scheduledFor);
  if (existing !== null) {
    log({ msg: "brief.already_sent", user_id: scope.user_id, brief_id: existing.brief_id });
    return { user_id: scope.user_id, status: "already_sent", brief_id: existing.brief_id };
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
  });

  const briefId = newBriefId();

  // Persisted BEFORE the send, including when it will be skipped. The skip is a record,
  // not just a log line: a user asking "why didn't I get one" deserves an answer that
  // outlives the log retention window.
  await insertBrief(scope, { brief_id: briefId, brief });

  const result = await deliverBrief({
    brief,
    channel: deps.channel,
    skip: decision,
    log,
  });

  if (!result.sent) {
    log({
      msg: "brief.not_sent",
      user_id: scope.user_id,
      brief_id: briefId,
      reason: result.reason,
      hours_stale: brief.staleness.hours_stale,
    });
    return { user_id: scope.user_id, status: "skipped", reason: result.reason };
  }

  // THE MAPPING, written down at the only moment it exists.
  //
  // `SendResult.message_id` is the provider's id for the message just sent, and
  // `inbound.v1.reply_to_message_id` will carry it back when the user replies "2". It
  // appears once, here, and cannot be reconstructed afterwards — so both halves go into
  // the same row: our `omsg_` and their id, plus the brief item it rendered.
  for (const { message, result: sendResult, item_index } of result.delivered) {
    const messageId = newOutboundMessageId();
    await insertOutboundMessage(scope, {
      message_id: messageId,
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
  }

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
