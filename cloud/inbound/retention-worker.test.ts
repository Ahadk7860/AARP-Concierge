import { describe, expect, it } from "vitest";

import { TurnRetentionError, TurnRetentionWorker, scheduleTurnRetention } from "./retention-worker.js";

describe("TurnRetentionWorker", () => {
  it("purges the exact boundary idempotently", async () => {
    const boundary = new Date("2026-11-03T12:00:00.000Z");
    const expiries = [
      new Date("2026-11-03T11:59:59.999Z"),
      boundary,
      new Date("2026-11-03T12:00:00.001Z"),
    ];
    const repository = {
      async purgeExpiredTurns(now: Date) {
        const before = expiries.length;
        for (let index = expiries.length - 1; index >= 0; index -= 1) {
          if (expiries[index]! <= now) expiries.splice(index, 1);
        }
        return before - expiries.length;
      },
    };
    const worker = new TurnRetentionWorker({ repository, now: () => boundary });
    await expect(worker.run()).resolves.toBe(2);
    await expect(worker.run()).resolves.toBe(0);
    expect(expiries).toEqual([new Date("2026-11-03T12:00:00.001Z")]);
  });

  it("coalesces concurrent runs and exposes a safe failure signal", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logs: unknown[] = [];
    const worker = new TurnRetentionWorker({
      repository: { purgeExpiredTurns: async () => { calls += 1; await gate; throw new Error("database detail"); } },
      log: (event) => { logs.push(event); },
    });
    const first = worker.run();
    const second = worker.run();
    expect(second).toBe(first);
    release();
    await expect(first).rejects.toEqual(new TurnRetentionError());
    expect(calls).toBe(1);
    expect(JSON.stringify(logs)).toBe('[{"msg":"turns.retention.failed"}]');
    expect(JSON.stringify(logs)).not.toContain("database detail");
  });

  it("ships an injected scheduling seam", async () => {
    let installed: (() => Promise<void>) | null = null;
    let stopped = false;
    const worker = new TurnRetentionWorker({ repository: { purgeExpiredTurns: async () => 0 } });
    const stop = scheduleTurnRetention(worker, {
      install(job) { installed = job; return () => { stopped = true; }; },
    });
    await (installed as unknown as () => Promise<void>)();
    stop();
    expect(stopped).toBe(true);
  });
});
