// The fleet-wide heartbeat alarm CONTRACTS.md UNRESOLVED item 10 calls for: "ship the
// fleet-wide heartbeat alarm regardless" of whether an FDA-equivalent grant survives a
// Sparkle auto-update.
//
// `messages_access_state: "lost"` on a heartbeat means the Mac's security-scoped
// bookmark to the user's Messages folder stopped resolving — most likely because an app
// update re-signed the binary and invalidated it. Until this file, that fact reached
// only a local macOS notification: a user whose Mac loses access at 3am gets nothing
// from the cloud, because the cloud never heard about it (the field itself could not
// even reach the API — see `heartbeat.v1.json`'s history).
//
// This is not the cold open: by the time a device is heartbeating, it has already
// completed pairing and the user has already texted Boi first (AMENDMENT-002 in
// `welcome.ts`), so initiating here does not walk into the "report junk" affordance
// that governs the first message of a relationship.

import type { OutboundMessage } from "../../shared/src/index.js";

export const MESSAGES_ACCESS_LOST_TEXT =
  "hey — I lost access to your Messages folder, so I can't read anything new right now. " +
  "open the Boi app on your Mac to restore access.";

/**
 * Composes the outbound.v1 notification for one loss episode.
 *
 * `idempotency_key` is scoped to `episodeKey` rather than to `userId` alone (contrast
 * `firstSyncOffer`'s `firstsync-${userId}`, which is deliberately ONE-PER-ACCOUNT-EVER).
 * A user can lose and regain access more than once over the life of a device, and each
 * loss deserves its own text — `messages_out`'s `unique (user_id, idempotency_key)`
 * only prevents a RETRY of the same send from arriving twice, so the key has to change
 * between distinct episodes for that uniqueness to do the right thing here.
 */
export function messagesAccessLostMessage(
  userId: string,
  deviceId: string,
  episodeKey: string,
): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: userId,
    idempotency_key: `messages-access-lost-${userId}-${deviceId}-${episodeKey}`,
    blocks: [{ type: "text", text: MESSAGES_ACCESS_LOST_TEXT }],
    reply_to_message_id: null,
  };
}

/**
 * Fire-once-per-episode gate for the alarm, keyed by device.
 *
 * There is no durable per-heartbeat history of `messages_access_state` to consult —
 * `devices` (migration 005) holds only the LATEST heartbeat's fields, and adding a
 * column to change that is out of scope here (see `INTERFACES.md`). So this tracks the
 * last state seen PER PROCESS: an episode is "new" the moment a `lost` heartbeat
 * follows anything that was not `lost` (including "never seen this device before"),
 * and the gate closes until a non-`lost` heartbeat reopens it.
 *
 * Deliberately in-memory and per-process, not per-fleet: a rolling API deploy or a
 * second replica can each re-open the gate once, so a user could in principle get the
 * text twice for what is really one continuous outage. That is the bounded, disclosed
 * cost of not touching `cloud/db/migrations/**` for this change — worse than a perfectly
 * deduplicated alarm, still enormously better than the silent status quo, and never
 * WORSE than the "every 15 minutes" spam this gate exists to prevent, because a single
 * process instance never re-fires for a `lost` streak it already reported.
 */
export class LossEpisodeGate {
  private readonly lastState = new Map<string, string | undefined>();

  /** True the first time `state` is seen as `"lost"` since the last non-`lost` state. */
  shouldAlert(deviceKey: string, state: string | undefined): boolean {
    const previous = this.lastState.get(deviceKey);
    this.lastState.set(deviceKey, state);
    return state === "lost" && previous !== "lost";
  }
}
