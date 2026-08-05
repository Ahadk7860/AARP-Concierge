import { describe, expect, it } from "vitest";

import {
  SpectrumStream,
  type SpectrumStreamObserver,
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

function recordingPort() {
  const observers: SpectrumStreamObserver[] = [];
  const closes: number[] = [];
  const port: SpectrumStreamPort = {
    async open(observer) {
      observers.push(observer);
      return { close: async () => { closes.push(observers.length - 1); } };
    },
  };
  return { port, observers, closes };
}

describe("SpectrumStream", () => {
  it("delivers only increasing, non-duplicate provider events", async () => {
    const fixture = recordingPort();
    const received: string[] = [];
    const stream = new SpectrumStream({ port: fixture.port, onEvent: async (event) => { received.push(event.id); } });

    await stream.start();
    const observer = fixture.observers[0]!;
    observer.event({ id: "evt_1", sequence: 4, payload: { text: "private text" } });
    observer.event({ id: "evt_1", sequence: 5, payload: { text: "duplicate id" } });
    observer.event({ id: "evt_old", sequence: 3, payload: { text: "late arrival" } });
    observer.event({ id: "evt_2", sequence: 6, payload: { text: "private text" } });
    await flushAsyncWork();

    expect(received).toEqual(["evt_1", "evt_2"]);
  });

  it("moves through connected and degraded, then reconnects", async () => {
    const fixture = recordingPort();
    const sleeps: number[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const logs: unknown[] = [];
    const stream = new SpectrumStream({
      port: fixture.port,
      onEvent: () => {},
      random: () => 0.5,
      baseReconnectMs: 100,
      maxReconnectMs: 150,
      sleep: async (ms) => { sleeps.push(ms); await gates[sleeps.length - 1]!.promise; },
      log: (event) => { logs.push(event); },
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    await stream.start();
    expect(stream.health()).toEqual({ state: "connected", connected_at: "2026-08-05T12:00:00.000Z", retry_attempt: 0 });

    fixture.observers[0]!.ended(new Error("provider text must not be logged"));
    await flushAsyncWork();
    expect(stream.health()).toEqual({ state: "degraded", connected_at: null, retry_attempt: 1 });
    expect(sleeps).toEqual([50]);
    expect(JSON.stringify(logs)).not.toContain("provider text");

    gates[0]!.resolve();
    await flushAsyncWork();
    expect(stream.health().state).toBe("connected");

    fixture.observers[1]!.ended();
    await flushAsyncWork();
    // A successful connection resets the consecutive-failure backoff.
    expect(sleeps).toEqual([50, 50]);
    gates[1]!.resolve();
    await flushAsyncWork();
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
    expect(stream.health().state).toBe("connected");
    expect(JSON.stringify(logs)).not.toContain("provider error text");
  });

  it("stops cleanly and ignores a late terminal callback", async () => {
    const fixture = recordingPort();
    const sleeps: number[] = [];
    const stream = new SpectrumStream({
      port: fixture.port,
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
