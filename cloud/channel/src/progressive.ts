// progressive.ts — multi-bubble progressive delivery.
//
// Contract per V3_ARCHITECTURE.md §4.4. Track F owns this file; Track B imports it.
//
// iMessage cannot stream tokens but it can stream messages — delivering bubble one
// as soon as it exists rather than waiting for the whole reply is the single biggest
// perceived-latency win available.

import type { UserScope } from "../../db/src/index.js";
import type { Channel, OutboundMessage } from "../../shared/src/index.js";

export type BubbleSink = {
  /** Deliver one bubble now. Safe to call repeatedly; ordering is preserved. */
  deliver(block: { type: "text"; text: string }): Promise<void>;
  /** No more bubbles. Flushes and closes the idempotency claim. */
  end(): Promise<void>;
};

/**
 * Open a progressive delivery sink.
 *
 * Contract: deliver() preserves call order; F handles batching and rate limits
 * internally. Calling deliver() then throwing is safe — whatever was delivered
 * stays delivered. end() is idempotent.
 */
export function openBubbleSink(input: {
  scope: UserScope;
  channel: Channel;
  idempotency_key: string;
  reply_to_message_id: string | null;
}): BubbleSink {
  let closed = false;
  const delivered: string[] = [];

  async function doDeliver(block: { type: "text"; text: string }): Promise<void> {
    if (closed) return;
    const msg: OutboundMessage = {
      schema_version: "outbound.v1",
      user_id: input.scope.user_id,
      idempotency_key: `${input.idempotency_key}-${delivered.length}`,
      blocks: [block],
      reply_to_message_id: input.reply_to_message_id,
    };
    await input.channel.send(msg);
    delivered.push(block.text);
  }

  return {
    async deliver(block) {
      if (closed) return;
      await doDeliver(block);
    },
    async end() {
      if (closed) return;
      closed = true;
      // Nothing to flush — each deliver() already sends immediately.
      // end() exists as the contract point for the idempotency claim
      // and for future batching optimizations.
    },
  };
}
