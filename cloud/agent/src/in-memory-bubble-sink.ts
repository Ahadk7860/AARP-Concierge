// In-memory `BubbleSink` test double.
//
// This file used to be `bubble-sink-stub.ts`, which mirrored Track F's `openBubbleSink()`
// (V3_ARCHITECTURE.md §4.4) while that file existed only on the unmerged `v3/deepseek`
// branch. `v3/deepseek` is now merged, so the mirrored `BubbleSink` type and the stub
// `openBubbleSink()` are gone — both come from `cloud/channel/src/progressive.ts` now, and
// the type is imported below rather than redeclared, so it cannot drift.
//
// What remains is the part that was never a stub: a sink that collects blocks in memory so
// tests (and `inbound-bridge.ts`, which must collapse bubbles into one `ChatReply`) can
// drive the agent loop without a live channel.
//
// KNOWN BEHAVIOURAL DIFFERENCE from the real sink, carried over from the stub's own note:
// the shipped `deliver()` mints per-bubble idempotency keys `${idempotency_key}-${n}`,
// derived from the turn's single key. This double does not model keys at all. Anything that
// asserts on idempotency-key shape must be tested against the real sink, not this one.

import type { BubbleSink } from "../../channel/src/progressive.js";

/**
 * Collects delivered blocks in order. The real sink batches, rate-limits, and actually
 * calls `channel.send`, none of which this deliberately attempts.
 */
export class InMemoryBubbleSink implements BubbleSink {
  readonly delivered: Array<{ type: "text"; text: string }> = [];
  private ended = false;

  async deliver(block: { type: "text"; text: string }): Promise<void> {
    if (this.ended) throw new Error("bubble_sink_already_ended");
    this.delivered.push(block);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  get isEnded(): boolean {
    return this.ended;
  }
}
