// Lifecycle management for Spectrum's inbound event stream.
//
// The provider SDK stream API has not been verified against a live project. This module
// therefore owns only lifecycle policy and depends on a deliberately small injected port.
// Provider event ids and cursors stay opaque until the real Photon adapter is documented.

export type SpectrumStreamEvent = {
  /** Stable provider event id. Used to make at-least-once delivery safe for consumers. */
  id: string;
  /** Opaque provider resume cursor. It has no ordering semantics in this layer. */
  cursor: string;
  /** Opaque provider event. This wrapper must never inspect or log it. */
  payload: unknown;
};

export type SpectrumStreamObserver = {
  event: (event: SpectrumStreamEvent) => void;
  ended: (error?: unknown) => void;
};

export type SpectrumStreamOpenOptions = {
  /** Last durably committed provider cursor, or null for a new subscription. */
  resume_after: string | null;
};

/** Adapter seam for the unverified Photon SDK. */
export interface SpectrumStreamPort {
  open(observer: SpectrumStreamObserver, options: SpectrumStreamOpenOptions): Promise<SpectrumStreamSession>;
}

export interface SpectrumStreamSession {
  close(): Promise<void>;
}

/** Durable state is injected so process restarts resume only after committed work. */
export interface SpectrumStreamCheckpoint {
  load(): Promise<string | null>;
  save(event: { event_id: string; cursor: string }): Promise<void>;
}

export type SpectrumStreamState = "stopped" | "connected" | "degraded";

export type SpectrumStreamHealth = {
  state: SpectrumStreamState;
  connected_at: string | null;
  retry_attempt: number;
};

export type SpectrumStreamLogEvent = {
  msg: "spectrum.stream.connected" | "spectrum.stream.degraded" | "spectrum.stream.stopped" | "spectrum.stream.consumer_failed";
  attempt?: number;
};

export type SpectrumStreamOptions = {
  port: SpectrumStreamPort;
  checkpoint: SpectrumStreamCheckpoint;
  onEvent: (event: SpectrumStreamEvent) => Promise<void> | void;
  /** Records operational state only. Event payloads and provider error strings never enter this log. */
  log?: (event: SpectrumStreamLogEvent) => void;
  now?: () => Date;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  stableConnectionMs?: number;
  /** Test seam. Returns a cancellation function. */
  schedule?: (milliseconds: number, callback: () => void) => () => void;
  /** Bounded memory for successfully committed event ids. */
  dedupeCapacity?: number;
};

const DEFAULT_BASE_RECONNECT_MS = 500;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;
const DEFAULT_DEDUPE_CAPACITY = 2_048;

/**
 * A restartable, single-session stream manager with at-least-once delivery.
 *
 * An event is remembered and its cursor advances only after both the consumer and the
 * durable checkpoint succeed. Consumer/checkpoint failure closes the unhealthy session,
 * degrades health, and reconnects from the last committed opaque cursor.
 */
export class SpectrumStream {
  private state: SpectrumStreamState = "stopped";
  private connectedAt: string | null = null;
  private retryAttempt = 0;
  private session: SpectrumStreamSession | null = null;
  private generation = 0;
  private readonly deliveredIds = new Set<string>();
  private readonly deliveredOrder: string[] = [];
  private readonly pendingIds = new Set<string>();
  private delivery = Promise.resolve();
  private cancelStableTimer: (() => void) | null = null;

  constructor(private readonly options: SpectrumStreamOptions) {
    if (!Number.isInteger(this.dedupeCapacity()) || this.dedupeCapacity() < 1) {
      throw new Error("dedupeCapacity must be a positive integer");
    }
    if (this.baseReconnectMs() < 1 || this.maxReconnectMs() < this.baseReconnectMs()) {
      throw new Error("reconnect bounds must be positive and max must be at least base");
    }
    if (this.stableConnectionMs() < 1) throw new Error("stableConnectionMs must be positive");
  }

  health(): SpectrumStreamHealth {
    return { state: this.state, connected_at: this.connectedAt, retry_attempt: this.retryAttempt };
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    const generation = ++this.generation;
    this.state = "degraded";
    await this.open(generation);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    ++this.generation;
    this.cancelStable();
    const session = this.session;
    this.session = null;
    this.state = "stopped";
    this.connectedAt = null;
    this.retryAttempt = 0;
    this.pendingIds.clear();
    this.log({ msg: "spectrum.stream.stopped" });
    if (session !== null) await session.close();
  }

  private async open(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    try {
      const resumeAfter = await this.options.checkpoint.load();
      if (!this.active(generation)) return;
      const session = await this.options.port.open({
        event: (event) => this.enqueue(event, generation),
        ended: () => { void this.reconnect(generation, false); },
      }, { resume_after: resumeAfter });
      if (!this.active(generation)) {
        await session.close();
        return;
      }
      this.session = session;
      this.state = "connected";
      this.connectedAt = this.now().toISOString();
      // Do not reset retryAttempt merely because a transport opened: a flapping
      // connection must retain exponential backoff until it proves stable.
      this.scheduleStableReset(generation);
      this.log({ msg: "spectrum.stream.connected" });
    } catch {
      await this.reconnect(generation, false);
    }
  }

  private async reconnect(generation: number, closeSession: boolean): Promise<void> {
    if (!this.active(generation)) return;
    const reconnectGeneration = ++this.generation;
    if (generation !== reconnectGeneration - 1) return;
    this.cancelStable();
    const session = this.session;
    this.session = null;
    this.state = "degraded";
    this.connectedAt = null;
    this.retryAttempt += 1;
    const attempt = this.retryAttempt;
    this.log({ msg: "spectrum.stream.degraded", attempt });
    if (closeSession && session !== null) {
      try { await session.close(); } catch { /* keep errors and provider metadata private */ }
    }
    if (!this.active(reconnectGeneration)) return;
    await this.sleep(this.reconnectDelay(attempt));
    await this.open(reconnectGeneration);
  }

  private enqueue(event: SpectrumStreamEvent, generation: number): void {
    if (!this.active(generation) || !this.valid(event) || this.deliveredIds.has(event.id) || this.pendingIds.has(event.id)) return;
    this.pendingIds.add(event.id);
    this.delivery = this.delivery.then(async () => {
      if (!this.active(generation)) {
        this.pendingIds.delete(event.id);
        return;
      }
      try {
        await this.options.onEvent(event);
        await this.options.checkpoint.save({ event_id: event.id, cursor: event.cursor });
        this.pendingIds.delete(event.id);
        this.rememberDelivered(event.id);
        this.resetBackoff(generation);
      } catch {
        // Do not accept, dedupe, or checkpoint failed work. Reconnecting asks the provider
        // to redeliver from the last durable cursor and leaves this event retryable.
        this.pendingIds.delete(event.id);
        this.log({ msg: "spectrum.stream.consumer_failed" });
        await this.reconnect(generation, true);
      }
    });
  }

  private valid(event: SpectrumStreamEvent): boolean {
    return event.id.length > 0 && event.cursor.length > 0;
  }

  private rememberDelivered(id: string): void {
    this.deliveredIds.add(id);
    this.deliveredOrder.push(id);
    if (this.deliveredOrder.length > this.dedupeCapacity()) {
      const oldest = this.deliveredOrder.shift();
      if (oldest !== undefined) this.deliveredIds.delete(oldest);
    }
  }

  private scheduleStableReset(generation: number): void {
    this.cancelStable();
    this.cancelStableTimer = this.schedule(this.stableConnectionMs(), () => this.resetBackoff(generation));
  }

  private resetBackoff(generation: number): void {
    if (!this.active(generation) || this.state !== "connected") return;
    this.retryAttempt = 0;
    this.cancelStable();
  }

  private cancelStable(): void {
    this.cancelStableTimer?.();
    this.cancelStableTimer = null;
  }

  private active(generation: number): boolean {
    return generation === this.generation && this.state !== "stopped";
  }

  private reconnectDelay(attempt: number): number {
    const capped = Math.min(this.maxReconnectMs(), this.baseReconnectMs() * 2 ** Math.min(attempt - 1, 30));
    return Math.floor(capped * this.random());
  }

  private schedule(milliseconds: number, callback: () => void): () => void {
    if (this.options.schedule !== undefined) return this.options.schedule(milliseconds, callback);
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private random(): number { return this.options.random?.() ?? Math.random(); }
  private sleep(milliseconds: number): Promise<void> {
    return this.options.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  private baseReconnectMs(): number { return this.options.baseReconnectMs ?? DEFAULT_BASE_RECONNECT_MS; }
  private maxReconnectMs(): number { return this.options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS; }
  private stableConnectionMs(): number { return this.options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS; }
  private dedupeCapacity(): number { return this.options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY; }
  private log(event: SpectrumStreamLogEvent): void { this.options.log?.(event); }
}
