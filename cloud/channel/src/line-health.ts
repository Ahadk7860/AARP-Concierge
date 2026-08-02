// Line health tracking, and the `line.health_changed` event.
//
// The event fires on a TRANSITION, never on a poll. A poller that emits every cycle
// produces a stream nobody can alert on: "banned" arriving every thirty seconds is
// indistinguishable from a line that just went down, so the one message that matters is
// buried in the ones that do not. Consumers of `line.health_changed` are entitled to
// assume each event is news.
//
// Provider-neutral: the health source is injected, so this works against any transport.

import type { LineId, LineRegistry, LineStatus } from "./line-registry.js";

/** `CONTRACTS.md` § 4, exactly: `{ line_id, from, to, at }`. */
export type LineHealthChanged = {
  line_id: LineId;
  from: LineStatus;
  to: LineStatus;
  at: string;
};

export type LineHealthListener = (event: LineHealthChanged) => void;

/** Reports the current status of one line. The adapter's `health()` fits this. */
export type LineHealthSource = (lineId: LineId) => Promise<LineStatus>;

export type LineHealthConfig = {
  /** How often a caller should poll. This module does not own a timer — a background
   *  interval inside a library is unstoppable in tests and invisible in production. */
  pollIntervalMs: number;
};

export function loadLineHealthConfig(env: NodeJS.ProcessEnv = process.env): LineHealthConfig {
  const raw = env.LINE_HEALTH_POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") return { pollIntervalMs: 60_000 };
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid LINE_HEALTH_POLL_INTERVAL_MS: ${raw}`);
  return { pollIntervalMs: n };
}

export class LineHealthMonitor {
  private readonly registry: LineRegistry;
  private readonly source: LineHealthSource;
  private readonly now: () => Date;
  private readonly listeners: LineHealthListener[] = [];
  /** Every transition seen, newest last. The audit trail for "when did this line go?" */
  readonly history: LineHealthChanged[] = [];

  constructor(registry: LineRegistry, source: LineHealthSource, now: () => Date = () => new Date()) {
    this.registry = registry;
    this.source = source;
    this.now = now;
  }

  on(listener: LineHealthListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Polls every line once. Emits only where the status actually moved. */
  async poll(): Promise<LineHealthChanged[]> {
    const changes: LineHealthChanged[] = [];
    for (const metric of this.registry.metrics()) {
      let status: LineStatus;
      try {
        status = await this.source(metric.line_id);
      } catch {
        // An unreachable health endpoint is not evidence of health. Degrade rather than
        // assume `up`; the same rule the adapter's health() follows.
        status = "degraded";
      }
      const change = this.record(metric.line_id, status);
      if (change !== null) changes.push(change);
    }
    return changes;
  }

  /** Records a status, emitting only on a genuine transition. */
  record(lineId: LineId, status: LineStatus): LineHealthChanged | null {
    const from = this.registry.statusOf(lineId);
    if (from === status) return null;

    this.registry.setStatus(lineId, status);
    const event: LineHealthChanged = { line_id: lineId, from, to: status, at: this.now().toISOString() };
    this.history.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}
