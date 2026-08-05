import { describe, expect, it } from "vitest";

import {
  SpectrumStream,
  type SpectrumStreamCheckpoint,
  type SpectrumStreamObserver,
  type SpectrumStreamOpenOptions,
  type SpectrumStreamPort,
} from "../src/spectrum-stream.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function memoryCheckpoint(initial: string | null = null) {
  let cursor = initial;
  const saved: Array<{ event_id: string; cursor: string }> = [];
  const checkpoint: SpectrumStreamCheckpoint = {
    load: async () => cursor,
    save: async (event) => { saved.push(event); cursor = event.cursor; },
  };
  return { checkpoint, saved };
}

function recordingPort() {
  const observers: SpectrumStreamObserver[] = [];
  const options: SpectrumStreamOpenOptions[] = [];
  const closes: number[] = [];
  const port: SpectrumStreamPort = {
    async open(observer, openedWith) {
      observers.push(observer);
      options.push(openedWith);
      const index = observers.length - 1;
      return { close: async () => { closes.push(index); } };
    },
  };
  return { port, observers, options, closes };
}

describe("SpectrumStream", () => {
  it("delivers unique opaque events without inventing global cursor ordering", async () => {
    const fixture = recordingPort();
    const durable = memoryCheckpoint("opaque-before");
    const received: string[] = [];
    const stream = new SpectrumStream({
      port: fixture.port,
      checkpoint: durable.checkpoint,
      onEvent: async (event) => { received.push(event.id); },
    });

    await stream.start();
    const observer = fixture.observers[0]!;
    observer.event({ id: "partition-a-4", cursor: "not-a-number:a4", payload: { text: "private" } });
    observer.event({ id: "partition-b-3", cursor: "not-a-number:b3", payload: { text: "late but unique" } });
    observer.event({ id: "partition-a-4", cursor: "different-duplicate-token", payload: { text: "duplicate" } });
    await flushAsyncWork();

    expect(received).toEqual(["partition-a-4", "partition-b-3"]);
    expect(durable.saved).toEqual([
      { event_id: "partition-a-4", cursor: "not-a-number:a4" },
      { event_id: "partition-b-3", cursor: "not-a-number:b3" },
    ]);
    expect(fixture.options).toEqual([{ resume_after: "opaque-before" }]);
  });

  it("keeps failed processing retryable and reconnects from the last durable cursor", async () => {
    const fixture = recordingPort();
    const durable = memoryCheckpoint("committed-before");
    const retryGate = deferred<void>();
    let attempts = 0;
    const stream = new SpectrumStream({
      port: fixture.port,
      checkpoint: durable.checkpoint,
      onEvent: async () => { attempts += 1; if (attempts === 1) throw new Error("private payload"); },
      sleep: async () => retryGate.promise,
    });

    await stream.start();
    const event = { id: "evt-retry", cursor: "opaque-retry", payload: { text: "private" } };
    fixture.observers[0]!.event(event);
    await flushAsyncWork();

    expect(stream.health()).toMatchObject({ state: "degraded", connected_at: null, retry_attempt: 1 });
    expect(durable.saved).toEqual([]);
    expect(fixture.closes).toEqual([0]);

    retryGate.resolve();
    await flushAsyncWork();
    expect(fixture.options[1]).toEqual({ resume_after: "committed-before" });
    fixture.observers[1]!.event(event);
    await flushAsyncWork();

    expect(attempts).toBe(2);
    expect(durable.saved).toEqual([{ event_id: "evt-retry", cursor: "opaque-retry" }]);
    expect(stream.health().retry_attempt).toBe(0);
  });

  it("does not commit or dedupe an event when durable checkpointing fails", async () => {
    const fixture = recordingPort();
    const retryGate = deferred<void>();
    let saves = 0;
    let deliveries = 0;
    const checkpoint: SpectrumStreamCheckpoint = {
      load: async () => null,
      save: async () => { saves += 1; if (saves === 1) throw new Error("database metadata"); },
    };
    const stream = new SpectrumStream({
      port: fixture.port,
      checkpoint,
      onEvent: () => { deliveries += 1; },
      sleep: async () => retryGate.promise,
    });

    await stream.start();
    const event = { id: "evt-checkpoint", cursor: "cursor-checkpoint", payload: {} };
    fixture.observers[0]!.event(event);
    await flushAsyncWork();
    expect(stream.health().state).toBe("degraded");

    retryGate.resolve();
    await flushAsyncWork();
    fixture.observers[1]!.event(event);
    await flushAsyncWork();
    expect({ saves, deliveries }).toEqual({ saves: 2, deliveries: 2 });
  });

  it("retains exponential backoff across flapping opens until stable", async () => {
    const fixture = recordingPort();
    const durable = memoryCheckpoint();
    const sleeps: number[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const stableCallbacks: Array<() => void> = [];
    const stream = new SpectrumStream({
      port: fixture.port,
      checkpoint: durable.checkpoint,
      onEvent: () => {},
      random: () => 0.5,
      baseReconnectMs: 100,
      maxReconnectMs: 400,
      sleep: async (ms) => { sleeps.push(ms); await gates[sleeps.length - 1]!.promise; },
      schedule: (_ms, callback) => { stableCallbacks.push(callback); return () => {}; },
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    await stream.start();
    fixture.observers[0]!.ended();
    await flushAsyncWork();
    expect(sleeps).toEqual([50]);

    gates[0]!.resolve();
    await flushAsyncWork();
    expect(stream.health()).toEqual({ state: "connected", connected_at: "2026-08-05T12:00:00.000Z", retry_attempt: 1 });
    fixture.observers[1]!.ended();
    await flushAsyncWork();
    expect(sleeps).toEqual([50, 100]);

    gates[1]!.resolve();
    await flushAsyncWork();
    expect(stream.health().retry_attempt).toBe(2);
    stableCallbacks.at(-1)!();
    expect(stream.health().retry_attempt).toBe(0);
    await stream.stop();
  });

  it("caps exponential retry backoff across consecutive failed opens", async () => {
    let opens = 0;
    const sleeps: number[] = [];
    const port: SpectrumStreamPort = {
      async open() {
        opens += 1;
        if (opens < 3) throw new Error("provider error text must not escape");
        return { close: async () => {} };
      },
    };
    const logs: unknown[] = [];
    const stream = new SpectrumStream({
      port,
      checkpoint: memoryCheckpoint().checkpoint,
      onEvent: () => {},
      random: () => 0.5,
      baseReconnectMs: 100,
      maxReconnectMs: 150,
      sleep: async (ms) => { sleeps.push(ms); },
      log: (event) => { logs.push(event); },
    });

    await stream.start();

    expect(opens).toBe(3);
    expect(sleeps).toEqual([50, 75]);
    expect(stream.health()).toMatchObject({ state: "connected", retry_attempt: 2 });
    expect(JSON.stringify(logs)).not.toContain("provider error text");
  });

  it("stops cleanly and ignores a late terminal callback", async () => {
    const fixture = recordingPort();
    const sleeps: number[] = [];
    const stream = new SpectrumStream({
      port: fixture.port,
      checkpoint: memoryCheckpoint().checkpoint,
      onEvent: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await stream.start();
    const observer = fixture.observers[0]!;
    await stream.stop();
    observer.ended();
    await Promise.resolve();

    expect(stream.health()).toEqual({ state: "stopped", connected_at: null, retry_attempt: 0 });
    expect(sleeps).toEqual([]);
    expect(fixture.closes).toEqual([0]);
  });
});
