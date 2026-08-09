// STUB for cloud/channel/src/progressive.ts `openBubbleSink()` (V3_ARCHITECTURE.md §4.4),
// owned by Track F (DeepSeek). Develop against this trivial in-memory sink until F's file
// lands on `main` (as of this writing it exists only on the unmerged `v3/deepseek` branch —
// Track H reconciles branches, this session does not cherry-pick across them).
//
// IMPORTANT: this stub is aligned to the SHIPPED signature on `v3/deepseek`, not the
// as-written §4.4 doc — the shipped `openBubbleSink()` takes a required `channel: Channel`
// that the frozen doc omits (logged by the orchestrator in INTERFACES.md; Track F has been
// asked to amend §4.4). Coding to the real signature now means the eventual swap stays a
// one-line import change:
//
//   - import { type BubbleSink, InMemoryBubbleSink, openBubbleSink } from "./bubble-sink-stub.js";
//   + import { type BubbleSink, openBubbleSink } from "../../channel/src/progressive.js";
//
// Contract both sides rely on (§4.4), preserved here:
//   - deliver() preserves call order.
//   - Calling deliver() then throwing is safe — whatever was delivered stays delivered.
//   - end() is idempotent.
//   - Bubbles are delivered only after the verifier clears them — never stream unverified
//     prose. That rule is enforced by the agent loop's caller, not by the sink itself.
//
// Not (yet) mirrored here: the shipped `deliver()` mints per-bubble idempotency keys
// `${idempotency_key}-${n}`, derived from the turn's single key rather than reusing it
// verbatim. This stub uses one key for the whole turn, which is simpler but not identical
// wire behavior — if the agent loop ever asserts on a specific idempotency key shape,
// that assumption needs revisiting against the real sink, not this stub.

import type { Channel } from "../../shared/src/index.js";
import type { UserScope } from "../../db/src/index.js";

export type BubbleSink = {
  /** Deliver one bubble now. Safe to call repeatedly; ordering is preserved. */
  deliver(block: { type: "text"; text: string }): Promise<void>;
  /** No more bubbles. Flushes and closes the idempotency claim. */
  end(): Promise<void>;
};

export type OpenBubbleSinkInput = {
  scope: UserScope;
  channel: Channel;
  idempotency_key: string;
  reply_to_message_id: string | null;
};

/**
 * Collects delivered blocks in order and "sends" once, on `end()`. Good enough to drive
 * the agent loop and its tests; the real sink batches, rate-limits, and actually calls
 * `channel.send`, which this stub deliberately does not attempt.
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

/** Same call shape as the shipped `openBubbleSink()` so agent-loop.ts's call site does
 * not need to change when the real import lands — only this function body is thrown away. */
export function openBubbleSink(_input: OpenBubbleSinkInput): BubbleSink {
  return new InMemoryBubbleSink();
}
