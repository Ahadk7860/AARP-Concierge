// Lifecycle management for Spectrums's inbound event stream.
//
// The provider SDK stream API has not been verified against a live project.  This module
// therefore owns only the lifecycle policy and depends on a deliberately small injected
// port.  The eventual Photon adapter belongs below this seam; inbound routing belongs in
// `cloud/inbound/`, not here.

export type SpectrumStreamEvent = {
  /** Stable provider event id. Used to make at-least-once delivery safe for consumers. */
  id: string;
  /** Monotonic provider cursor. Events at or below a delivered cursor are stale. */
  sequence: number;
  /** Opaque provider event. This wrapper must never inspect or log it. */
  payload: unknown;
};

export type SpectrumStreamObserver = {
  event: (event: SpectrumStreamEvent) => void;
  ended: (error?: unknown) => void;
};

/**
 * Adapter seam for the unverified Photon SDK. `open` must arrange for `ended` to be called
 * exactly once once its session can no longer produce events. It may resolve only after a
 * transport is established; rejected opens are treated exactly like a terminated session.
 */
export interface SpectrumStreamPort {
  open(observer: SpectrumStreamObserver): Promise<SpectrumStreamSession>;
}

export interface SpectrumStreamSession {
  close(): Promise<void>;
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
  onEvent: (event: SpectrumStreamEvent) => Promise<void> | void;
  /** Records operational state only. Event payloads and provider error strings never enter this log. */
  log?: (event: SpectrumStreamLogEvent) => void;
  now?: () => Date;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  /** Bounded event-id memory. Cursor ordering is still the primary stale-event guard. */
  dedupeCapacity?: number;
};

const DEFAULT_BASE_RECONNECT_MS = 500;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const DEFAULT_DEDUPE_CAPACITY = 2_048;

/**
 * A restartable, single-session stream manager.
 *
 * It never routes provider payloads or retries the provider adapter itself. It accepts
 * at-least-once stream events, delivers only increasing cursors, and reconnects after a
 * close/open failure using capped exponential backoff with full jitter.
 */
export class SpectrumStream {
  private state: SpectrumStreamState = "stopped";
  private connectedAt: string | null = null;
  private retryAttempt = 0;
  private session: SpectrumStreamSession | null = null;
  private generation = 0;
  private highestSequence = Number.NEGATIVE_INFINITY;
  private readonly deliveredIds = new Set<string>();
  private readonly deliveredOrder: string[] = [];
  private delivery = Promise.resolve();

  constructor(private readonly options: SpectrumStreamOptions) {
    if (!Number.isInteger(this.dedupeCapacity()) || this.dedupeCapacity() < 1) {
      throw new Error("dedupeCapacity must be a positive integer");
    }
    if (this.baseReconnectMs() < 1 || this.maxReconnectMs() < this.baseReconnectMs()) {
      throw new Error("reconnect bounds must be positive and max must be at least base");
    }
  }

  health(): SpectrumStreamHealth {
    return { state: this.state, connected_at: this.connectedAt, retry_attempt: this.retryAttempt };
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    const generation = ++this.generation;
    // `degraded` also means "connecting" until the adapter has established a session.
    // It is intentionally the conservative health answer for an open that is in flight.
    this.state = "degraded";
    await this.open(generation);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    ++this.generation;
    const session = this.session;
    this.session = null;
    this.state = "stopped";
    this.connectedAt = null;
    this.retryAttempt = 0;
    this.log({ msg: "spectrum.stream.stopped" });
    if (session !== null) await session.close();
  }

  private async open(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    try {
      const session = await this.options.port.open({
        event: (event) => this.enqueue(event, generation),
        ended: () => { void this.reconnect(generation); },
      });
      if (!this.active(generation)) {
        await session.close();
        return;
      }
      this.session = session;
      this.state = "connected";
      this.connectedAt = this.now().toISOString();
      this.retryAttempt = 0;
      this.log({ msg: "spectrum.stream.connected" });
    } catch {
      await this.reconnect(generation);
    }
  }

  private async reconnect(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    // A provider can report the same close more than once. The generation increments for
    // each accepted reconnect, making duplicate terminal callbacks harmless.
    const reconnectGeneration = ++this.generation;
    if (generation !== reconnectGeneration - 1) return;
    this.session = null;
    this.state = "degraded";
    this.connectedAt = null;
    this.retryAttempt += 1;
    const attempt = this.retryAttempt;
    this.log({ msg: "spectrum.stream.degraded", attempt });
    await this.sleep(this.reconnectDelay(attempt));
    await this.open(reconnectGeneration);
  }

  private enqueue(event: SpectrumStreamEvent, generation: number): void {
    if (!this.active(generation) || !this.accept(event)) return;
    this.delivery = this.delivery.then(async () => {
      try {
        await this.options.onEvent(event);
      } catch {
        // Delivery failure is observable but must not turn an inbound message into a
        // stream reconnect loop; durable retries are the inbound worker's responsibility.
        this.log({ msg: "spectrum.stream.consumer_failed" });
      }
    });
  }

  private accept(event: SpectrumStreamEvent): boolean {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.id.length === 0) return false;
    if (event.sequence <= this.highestSequence || this.deliveredIds.has(event.id)) return false;
    this.highestSequence = event.sequence;
    this.deliveredIds.add(event.id);
    this.deliveredOrder.push(event.id);
    if (this.deliveredOrder.length > this.dedupeCapacity()) {
      const oldest = this.deliveredOrder.shift();
      if (oldest !== undefined) this.deliveredIds.delete(oldest);
    }
    return true;
  }

  private active(generation: number): boolean {
    return generation === this.generation && this.state !== "stopped";
  }

  private reconnectDelay(attempt: number): number {
    const capped = Math.min(this.maxReconnectMs(), this.baseReconnectMs() * 2 ** Math.min(attempt - 1, 30));
    return Math.floor(capped * this.random());
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private random(): number { return this.options.random?.() ?? Math.random(); }
  private sleep(milliseconds: number): Promise<void> {
    return this.options.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  private baseReconnectMs(): number { return this.options.baseReconnectMs ?? DEFAULT_BASE_RECONNECT_MS; }
  private maxReconnectMs(): number { return this.options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS; }
  private dedupeCapacity(): number { return this.options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY; }
  private log(event: SpectrumStreamLogEvent): void { this.options.log?.(event); }
}
