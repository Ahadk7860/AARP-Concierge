// RoutedChannel — sticky line assignment, automatic downgrade, and the re-introduction
// a user gets when their number changes.
//
// Two product rules drive everything here:
//
//   GREEN AND LATE BEATS BLUE AND NEVER. An unhealthy line degrades the send in the SAME
//   turn rather than failing it. A brief that arrives over SMS is a brief that arrived.
//
//   A LINE CHANGE IS A RETENTION EVENT. Arriving from a new number and resuming
//   mid-conversation reads as a stranger who somehow knows you. The first message from a
//   new line says so, in plain words, exactly once.
//
// Provider-neutral: this composes `Channel`s and never learns who carries them. The
// fallback is any `Channel` — Track D wires the real one, and Linq's own RCS/SMS fallback
// covers per-message degradation, so this is business continuity rather than a per-message
// path.

import type { Capabilities, Channel, ChannelHealth, InboundMessage, OutboundMessage, SendResult } from "../../shared/src/contracts.js";
import { ChannelError, type ChannelErrorCode } from "./errors.js";
import { LineHealthMonitor } from "./line-health.js";
import type { LineId, LineRegistry, LineStatus } from "./line-registry.js";

/** Which path a send actually took. `SendResult` is frozen and carries `provider`, which
 *  already distinguishes them; this is the richer record for metrics and for the log. */
export type RouteRecord = {
  user_id: string;
  line_id: LineId;
  path: "primary" | "fallback";
  /** Why the fallback was used, or null on the primary path. */
  reason: "line_unhealthy" | "primary_failed" | null;
  introduced: boolean;
  at: string;
};

export type RoutedChannelConfig = {
  /** Degrade to the fallback when the assigned line is in one of these states. Config
   *  rather than a constant: whether a `degraded` line is worth degrading FOR is exactly
   *  the sort of thing the first live incident will change our mind about. */
  degradeOn: LineStatus[];
  /** CONTRACTS.md § 11 item 4 — if the SLA turns out to cover line-level bans, a ban
   *  becomes the provider's problem to fix and we stop migrating users off it. */
  banCoveredBySla: boolean;
  /** The words a user sees when their number changes. Not auto-send: this rides along
   *  with a message they were getting anyway. */
  introductionText: string;
};

export const DEFAULT_INTRODUCTION =
  "hey — this is Boi, texting you from a new number. same conversation, new bubbles. save this one so i don't end up in your filtered messages.";

export function loadRoutedChannelConfig(env: NodeJS.ProcessEnv = process.env): RoutedChannelConfig {
  const raw = env.LINE_DEGRADE_ON;
  const degradeOn: LineStatus[] =
    raw === undefined || raw === ""
      ? ["banned"]
      : raw.split(",").map((s) => {
          const v = s.trim();
          if (v === "up" || v === "degraded" || v === "banned") return v;
          throw new Error(`invalid LINE_DEGRADE_ON: ${s} (expected up, degraded or banned)`);
        });
  return {
    degradeOn,
    banCoveredBySla: (env.LINE_BAN_COVERED_BY_SLA ?? "").trim().toLowerCase() === "true" || env.LINE_BAN_COVERED_BY_SLA === "1",
    introductionText: env.LINE_INTRODUCTION_TEXT ?? DEFAULT_INTRODUCTION,
  };
}

/**
 * The only failures worth degrading for. Both are line-level and both are
 * `retryable: false` — a retryable error must NOT reach the fallback, because retrying
 * the primary is the correct response and the fallback would mask it.
 */
const DOWNGRADE_ON_CODES: ReadonlySet<ChannelErrorCode> = new Set<ChannelErrorCode>(["line_banned", "line_unavailable"]);

export type RoutedChannelDeps = {
  primary: Channel;
  fallback: Channel;
  registry: LineRegistry;
  monitor: LineHealthMonitor;
  now?: () => Date;
};

export class RoutedChannel implements Channel {
  private readonly config: RoutedChannelConfig;
  private readonly primary: Channel;
  private readonly fallback: Channel;
  private readonly registry: LineRegistry;
  private readonly monitor: LineHealthMonitor;
  private readonly now: () => Date;
  /** Every send's route. Bounded by the caller's usage; Track D persists what it needs. */
  readonly routes: RouteRecord[] = [];

  constructor(config: RoutedChannelConfig, deps: RoutedChannelDeps) {
    this.config = config;
    this.primary = deps.primary;
    this.fallback = deps.fallback;
    this.registry = deps.registry;
    this.monitor = deps.monitor;
    this.now = deps.now ?? (() => new Date());
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    // Sticky: this returns the existing assignment untouched, so calling it on every send
    // is what enforces stickiness rather than merely intending it.
    const lineId = this.registry.assign(msg.user_id);
    const status = this.registry.statusOf(lineId);

    const outgoing = this.withIntroduction(msg, lineId);
    const unhealthy = this.config.degradeOn.includes(status);

    if (unhealthy) {
      // Known-bad line: do not spend a doomed attempt on it first. Retrying a banned line
      // is what deepens the ban.
      return this.viaFallback(msg, outgoing, lineId, "line_unhealthy");
    }

    try {
      const result = await this.primary.send(outgoing);
      this.commitIntroduction(msg.user_id, lineId, outgoing !== msg);
      this.routes.push({
        user_id: msg.user_id,
        line_id: lineId,
        path: "primary",
        reason: null,
        introduced: outgoing !== msg,
        at: this.now().toISOString(),
      });
      return result;
    } catch (err) {
      // Same turn, not a retry queue. A brief that arrives tomorrow is not a brief.
      //
      // ONE RULE: downgrade only for a LINE-level failure. A rate limit is our own
      // throttling, a malformed response is our bug, a 500 is the platform — burning the
      // fallback on any of those spends a second provider's quota to hide a signal we
      // need. `DOWNGRADE_ON_CODES` is the whole decision, asserted class by class in
      // line-health.test.ts.
      if (!(err instanceof ChannelError)) throw err;
      if (!DOWNGRADE_ON_CODES.has(err.code)) throw err;
      if (err.code === "line_banned") this.onBanned(lineId);
      return this.viaFallback(msg, outgoing, lineId, "primary_failed");
    }
  }

  private async viaFallback(
    original: OutboundMessage,
    outgoing: OutboundMessage,
    lineId: LineId,
    reason: NonNullable<RouteRecord["reason"]>,
  ): Promise<SendResult> {
    const result = await this.fallback.send(outgoing);
    this.commitIntroduction(original.user_id, lineId, outgoing !== original);
    this.routes.push({
      user_id: original.user_id,
      line_id: lineId,
      path: "fallback",
      reason,
      introduced: outgoing !== original,
      at: this.now().toISOString(),
    });
    return result;
  }

  /** A ban is a migration event, not an error to retry — unless the SLA turns out to
   *  cover it, in which case it is the provider's to fix and we leave users in place. */
  private onBanned(lineId: LineId): void {
    this.monitor.record(lineId, "banned");
    if (this.config.banCoveredBySla) return;
    for (const userId of this.registry.usersOn(lineId)) {
      try {
        this.registry.migrate(userId, "health");
      } catch {
        // No spare capacity. The users stay put and the next send degrades to the
        // fallback; better than throwing away the assignment and having nowhere to put it.
        break;
      }
    }
  }

  /** Prepends the "new number" preamble the first time this user is messaged from this
   *  line. Returns the original message untouched when no introduction is due, so
   *  `outgoing !== msg` is a reliable "was introduced" signal. */
  private withIntroduction(msg: OutboundMessage, lineId: LineId): OutboundMessage {
    if (!this.registry.needsIntroduction(msg.user_id, lineId)) return msg;
    return { ...msg, blocks: [{ type: "text", text: this.config.introductionText }, ...msg.blocks] };
  }

  /** Marked only after the send succeeds. Marking before would mean a failed send burns
   *  the introduction and the user never gets told the number changed. */
  private commitIntroduction(userId: string, lineId: LineId, introduced: boolean): void {
    if (introduced) this.registry.markIntroduced(userId, lineId);
  }

  async capabilities(): Promise<Capabilities> {
    return this.primary.capabilities();
  }

  async health(): Promise<ChannelHealth> {
    return this.primary.health();
  }

  normalizeInbound(rawBody: unknown, signature: string): InboundMessage {
    return this.primary.normalizeInbound(rawBody, signature);
  }
}
