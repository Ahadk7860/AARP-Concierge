// brief.v1 -> outbound.v1 -> Channel.
//
// No provider semantics appear in this file. The composer emits blocks and never learns
// whether delivery was blue, green or grey — that is the whole point of the `Channel`
// interface, and the reason Track C's adapter can drop in behind it unchanged.
//
// **Never auto-send.** Every draft goes to the USER, for them to send on. `outbound.v1`
// carries a `user_id` and no recipient, so there is structurally nowhere to put a
// contact's handle — but `deliver.test.ts` asserts it anyway, because this is the one
// mistake in the system that cannot be taken back.

import type {
  Brief,
  BriefItem,
  Channel,
  OutboundBlock,
  OutboundMessage,
  SendResult,
} from "../../shared/src/index.js";

/**
 * One message, what the transport called it, and which brief item it rendered.
 *
 * `result.message_id` is the PROVIDER's id, and this is the only moment it exists.
 * `inbound.v1.reply_to_message_id` will carry it back when the user replies, and
 * nothing else in the system can reconstruct the link — so `deliverBrief` returns it
 * rather than discarding it, and `run.ts` writes it to `messages_out`.
 *
 * Returning `SendResult` alongside the message is not incidental. An earlier version
 * returned only the messages, the provider id was never persisted, and every threaded
 * reply resolved to "ambiguous" because the mapping did not exist.
 */
export type SentMessage = {
  message: OutboundMessage;
  result: SendResult;
  /** Null for the lead and for an unthreaded send carrying every item at once. */
  item_index: number | null;
};

export type DeliveryResult =
  | { sent: true; messages: OutboundMessage[]; delivered: SentMessage[]; threaded: boolean }
  | { sent: false; reason: "digest_too_stale" | "nothing_to_say"; messages: []; delivered: [] };

/** A stable idempotency key: one brief, one morning, however many times it retries. */
export function briefIdempotencyKey(brief: Brief, suffix: string): string {
  return `brief-${brief.user_id}-${brief.scheduled_for}${suffix}`;
}

/** The lead message: the staleness caveat, if any, then the framing line. */
export function leadBlocks(brief: Brief): OutboundBlock[] {
  const blocks: OutboundBlock[] = [];

  // The caveat goes FIRST, before any content it qualifies. Underneath the items it
  // would be a footnote on something the reader has already believed.
  const caveat = brief.staleness.message;
  if (brief.staleness.warn && typeof caveat === "string" && caveat.length > 0) {
    blocks.push({ type: "text", text: caveat });
  }

  const n = brief.items.length;
  blocks.push({
    type: "text",
    text: n === 1 ? "one person worth a message today:" : `${n} people worth a message today:`,
  });
  return blocks;
}

const REMEDY_PROMPT: Record<BriefItem["remedy"], string> = {
  reply: "reply",
  call: "call",
  dismiss: "dismiss",
  snooze: "snooze",
};

/**
 * One item, as blocks.
 *
 * The degraded case matters more than the happy one. When `drafts` is null the item
 * shows the headline, the gist and the remedy, and says NOTHING about drafts — no
 * "couldn't write drafts", no empty quotes, no placeholder. A brief with no draft is
 * fine; a brief that gestures at a draft that is not there is a broken product.
 */
export function itemBlocks(item: BriefItem): OutboundBlock[] {
  const blocks: OutboundBlock[] = [
    { type: "text", text: `${item.display} — ${item.headline}` },
    { type: "text", text: item.gist },
  ];

  const candidates = item.drafts?.candidates ?? [];
  if (candidates.length > 0) {
    // Exactly two, differing in stance. The label is what makes it a choice rather than
    // two paraphrases: CONTRACTS.md § 1 is explicit that two rewordings of one sentence
    // is a fake choice and users notice immediately.
    for (const candidate of candidates) {
      blocks.push({ type: "text", text: `${candidate.stance}: ${candidate.text}` });
    }
    blocks.push({ type: "text", text: `send one, or ${REMEDY_PROMPT[item.remedy]}` });
  } else {
    // No drafts. Still a remedy — never a reveal without an action.
    blocks.push({ type: "text", text: `${REMEDY_PROMPT[item.remedy]} when you get a minute` });
  }

  return blocks;
}

export type DeliverInput = {
  brief: Brief;
  channel: Channel;
  skip?: { skip: boolean; skip_reason: "digest_too_stale" | null };
  log?: (event: Record<string, unknown>) => void;
  /**
   * Idempotency keys already delivered on a previous attempt. Those sends are skipped.
   *
   * Without this a retry after a partial failure re-sends everything that DID work, so
   * a user whose third message failed gets the first two twice.
   */
  alreadySent?: ReadonlySet<string>;
  /**
   * Called after EACH successful send, before the next one is attempted.
   *
   * The provider id has to be persisted per message rather than after the loop: if
   * message three throws, messages one and two are already out in the world and the
   * mapping for them must survive the throw. Recording them afterwards loses exactly
   * the ones a retry needs to know about.
   */
  onSent?: (sent: SentMessage) => Promise<void>;
  /** The lead's provider id from an earlier attempt, when resuming after a failure. */
  leadProviderMessageId?: string | null;
};

/**
 * Send the brief.
 *
 * With threading, each item becomes its own message replying to the lead, so a user can
 * react to one person without the thread collapsing into a wall. Without it, everything
 * goes in one message — **silently**. A transport that cannot thread is not an error
 * condition, and telling the user their phone is missing a feature helps nobody.
 */
export async function deliverBrief(input: DeliverInput): Promise<DeliveryResult> {
  const { brief, channel } = input;
  const log = input.log ?? (() => {});

  if (input.skip?.skip === true) {
    log({
      msg: "brief.skipped",
      user_id: brief.user_id,
      reason: input.skip.skip_reason,
      hours_stale: brief.staleness.hours_stale,
    });
    return { sent: false, reason: "digest_too_stale", messages: [], delivered: [] };
  }

  if (brief.items.length === 0) {
    // Nothing to say is a legitimate morning. Sending "you have 0 people today" every
    // day is how a habit becomes a notification people turn off.
    log({ msg: "brief.empty", user_id: brief.user_id });
    return { sent: false, reason: "nothing_to_say", messages: [], delivered: [] };
  }

  const capabilities = await channel.capabilities();
  const threaded = capabilities.threading === true;
  const messages: OutboundMessage[] = [];
  const delivered: SentMessage[] = [];
  const alreadySent = input.alreadySent ?? new Set<string>();
  const onSent = input.onSent ?? (async () => {});

  /** Send unless a previous attempt already did, recording it before returning. */
  async function dispatch(
    message: OutboundMessage,
    itemIndex: number | null,
  ): Promise<SendResult | null> {
    messages.push(message);
    if (alreadySent.has(message.idempotency_key)) {
      log({ msg: "brief.resend_skipped", user_id: brief.user_id, key: message.idempotency_key });
      return null;
    }
    const result = await channel.send(message);
    const sent: SentMessage = { message, result, item_index: itemIndex };
    delivered.push(sent);
    await onSent(sent);
    return result;
  }

  const lead: OutboundMessage = {
    schema_version: "outbound.v1",
    user_id: brief.user_id,
    idempotency_key: briefIdempotencyKey(brief, "-lead"),
    blocks: threaded
      ? leadBlocks(brief)
      : [...leadBlocks(brief), ...brief.items.flatMap((i) => itemBlocks(i))],
    reply_to_message_id: null,
    ...(threaded ? { requested_capabilities: ["threading"] } : {}),
  };

  const leadResult = await dispatch(lead, null);

  if (threaded) {
    // A resumed attempt has no fresh lead result. The lead's provider id is already in
    // `messages_out` from the attempt that sent it, so thread to the recorded one.
    const leadProviderId = leadResult?.message_id ?? input.leadProviderMessageId ?? null;
    for (const [index, item] of brief.items.entries()) {
      const message: OutboundMessage = {
        schema_version: "outbound.v1",
        user_id: brief.user_id,
        idempotency_key: briefIdempotencyKey(brief, `-item-${index}`),
        blocks: itemBlocks(item),
        reply_to_message_id: leadProviderId,
        requested_capabilities: ["threading"],
      };
      await dispatch(message, index);
    }
  }

  log({
    msg: "brief.sent",
    user_id: brief.user_id,
    items: brief.items.length,
    threaded,
    warn: brief.staleness.warn,
  });

  return { sent: true, messages, delivered, threaded };
}
