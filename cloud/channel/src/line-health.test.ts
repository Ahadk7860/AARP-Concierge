import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer, DEV_TOKEN, type MockLinqConfig, type MockLinqServer } from "../../mock-linq/src/server.js";
import { StubChannel } from "../../shared/src/stub-channel.js";
import type { Channel, OutboundMessage, SendResult } from "../../shared/src/contracts.js";
import { LinqChannel, loadLinqChannelConfig } from "./linq-channel.js";
import {
  CapabilityError,
  ChannelError,
  EmptyMessageError,
  LineBannedError,
  LineUnavailableError,
  RateLimitedError,
  UpstreamError,
} from "./errors.js";
import {
  LineRegistry,
  loadLineRegistryConfig,
  NoLineCapacityError,
  parseLinePool,
  type LineDefinition,
  type LineRegistryConfig,
} from "./line-registry.js";
import { LineHealthMonitor, loadLineHealthConfig, type LineHealthChanged } from "./line-health.js";
import { RawBodyRequiredError, SignatureError } from "./inbound.js";
import { RoutedChannel, loadRoutedChannelConfig, DEFAULT_INTRODUCTION, type RoutedChannelConfig } from "./routed-channel.js";

// CONTRACTS.md § 9: Track C's channel test server is 3032. The mock from prompt 01 backs
// the primary channel so downgrade is exercised against a real socket and a real 503.
const PORT = 3035;
const LINES: LineDefinition[] = [
  { line_id: "line_a1", handle: "+15550100123" },
  { line_id: "line_a2", handle: "+15550100124" },
  { line_id: "line_a3", handle: "+15550100125" },
];

let mock: MockLinqServer;

function mockConfig(): MockLinqConfig {
  return {
    port: PORT,
    host: "127.0.0.1",
    mode: "up",
    lineId: "line_a1",
    fromHandle: "+15550100123",
    webhookSecret: "dev-secret-change-me",
    webhookUrl: null,
    expectedToken: DEV_TOKEN,
    retryAfterSeconds: 30,
    pathPrefix: "/api/partner/v3",
    logLevel: "silent",
  };
}

beforeAll(async () => {
  mock = buildServer(mockConfig());
  await mock.app.listen({ port: PORT, host: "127.0.0.1" });
});

afterAll(async () => {
  await mock.app.close();
});

beforeEach(() => {
  mock.config.mode = "up";
  mock.recorder.clear();
});

function registryConfig(overrides: Partial<LineRegistryConfig> = {}): LineRegistryConfig {
  return { lines: LINES, usersPerLine: 5, sticky: true, assumeRotationNotice: false, banCoveredBySla: false, ...overrides };
}

function routedConfig(overrides: Partial<RoutedChannelConfig> = {}): RoutedChannelConfig {
  return { degradeOn: ["banned"], banCoveredBySla: false, introductionText: DEFAULT_INTRODUCTION, ...overrides };
}

function primaryChannel(): LinqChannel {
  return new LinqChannel(
    loadLinqChannelConfig({
      LINQ_BASE_URL: `http://127.0.0.1:${PORT}/api/partner/v3`,
      LINQ_API_TOKEN: DEV_TOKEN,
      LINQ_FROM_HANDLE: "+15550100123",
      LINQ_LINE_ID: "line_a1",
      // The production default is 30/minute, so 100 consecutive sends would sit in the
      // limiter's delay for ~2 real minutes. That is the limiter working correctly and
      // is asserted in linq-channel.test.ts; raising it here keeps the stickiness test
      // about stickiness. Configuration, not a weakened assertion.
      CHANNEL_RATE_LIMIT_MAX: "10000",
    } as NodeJS.ProcessEnv),
    { resolveHandles: () => ["+15551234567"] },
  );
}

function message(userId: string, key: string): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: userId,
    idempotency_key: key,
    blocks: [{ type: "text", text: "3 people are waiting on you." }],
  };
}

type Harness = {
  registry: LineRegistry;
  monitor: LineHealthMonitor;
  routed: RoutedChannel;
  fallback: StubChannel;
};

function harness(opts: { registry?: Partial<LineRegistryConfig>; routed?: Partial<RoutedChannelConfig>; primary?: Channel } = {}): Harness {
  const registry = new LineRegistry(registryConfig(opts.registry));
  const monitor = new LineHealthMonitor(registry, async () => "up");
  const fallback = new StubChannel("up", "line_fallback");
  const routed = new RoutedChannel(routedConfig(opts.routed), {
    primary: opts.primary ?? primaryChannel(),
    fallback,
    registry,
    monitor,
  });
  return { registry, monitor, routed, fallback };
}

describe("line registry — sticky assignment", () => {
  it("a user keeps their line across 100 consecutive sends", async () => {
    const { registry, routed } = harness();
    const first = registry.assign("usr_sticky");

    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      await routed.send(message("usr_sticky", `sticky-${i}`));
      seen.add(registry.lineFor("usr_sticky") ?? "");
    }

    expect(seen.size, `line moved: ${[...seen].join(", ")}`).toBe(1);
    expect(registry.lineFor("usr_sticky")).toBe(first);
    expect(routed.routes).toHaveLength(100);
    expect(routed.routes.every((r) => r.line_id === first)).toBe(true);
  });

  it("different users share a line up to capacity, then a new line is allocated", () => {
    const registry = new LineRegistry(registryConfig({ usersPerLine: 2 }));
    expect(registry.assign("usr_1")).toBe("line_a1");
    expect(registry.assign("usr_2")).toBe("line_a1");
    // Third user does not fit on line_a1.
    expect(registry.assign("usr_3")).toBe("line_a2");
    expect(registry.usersOn("line_a1")).toEqual(["usr_1", "usr_2"]);
    expect(registry.usersOn("line_a2")).toEqual(["usr_3"]);
  });

  it("users-per-line is configuration, defaulting low", () => {
    expect(loadLineRegistryConfig({} as NodeJS.ProcessEnv).usersPerLine).toBe(5);
    expect(loadLineRegistryConfig({ LINE_USERS_PER_LINE: "2" } as NodeJS.ProcessEnv).usersPerLine).toBe(2);
    expect(() => loadLineRegistryConfig({ LINE_USERS_PER_LINE: "0" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadLineRegistryConfig({ LINE_USERS_PER_LINE: "lots" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("refuses to over-pack a line when the pool is exhausted", () => {
    const registry = new LineRegistry(registryConfig({ lines: [LINES[0] as LineDefinition], usersPerLine: 1 }));
    registry.assign("usr_1");
    // Silently exceeding tenancy is the failure this guards: ban risk is super-linear in
    // users per line, so quietly adding one more is exactly the wrong degradation.
    expect(() => registry.assign("usr_2")).toThrow(NoLineCapacityError);
  });

  it("parses a line pool from config", () => {
    expect(parseLinePool("line_a1=+1555,line_a2=+1556")).toEqual([
      { line_id: "line_a1", handle: "+1555" },
      { line_id: "line_a2", handle: "+1556" },
    ]);
    expect(parseLinePool(undefined)).toEqual([]);
    expect(() => parseLinePool("line_a1")).toThrow(/expected line_id=handle/);
  });
});

describe("line registry — the blast-radius query", () => {
  it("given a line_id, one call returns every affected user", () => {
    const registry = new LineRegistry(registryConfig({ usersPerLine: 5 }));
    registry.assign("usr_alpha");
    registry.assign("usr_beta");
    registry.assign("usr_gamma");

    const affected = registry.usersOn("line_a1");
    expect(affected).toEqual(["usr_alpha", "usr_beta", "usr_gamma"]);
    expect(registry.usersOn("line_a2")).toEqual([]);
    expect(registry.usersOn("line_nonexistent")).toEqual([]);
  });

  it("the metric surface reports users-per-line and health for every line", () => {
    const registry = new LineRegistry(registryConfig({ usersPerLine: 2 }));
    registry.assign("usr_1");
    registry.assign("usr_2");
    registry.assign("usr_3");
    registry.setStatus("line_a1", "banned");

    expect(registry.metrics()).toEqual([
      { line_id: "line_a1", handle: "+15550100123", status: "banned", user_count: 2, capacity: 2, full: true },
      { line_id: "line_a2", handle: "+15550100124", status: "up", user_count: 1, capacity: 2, full: false },
      { line_id: "line_a3", handle: "+15550100125", status: "up", user_count: 0, capacity: 2, full: false },
    ]);
  });
});

describe("line health — transitions, not polls", () => {
  it("emits line.health_changed exactly once per transition across a poll loop", async () => {
    const registry = new LineRegistry(registryConfig({ lines: [LINES[0] as LineDefinition] }));
    let reported: "up" | "degraded" | "banned" = "up";
    const monitor = new LineHealthMonitor(registry, async () => reported);

    const events: LineHealthChanged[] = [];
    monitor.on((e) => events.push(e));

    for (let i = 0; i < 5; i += 1) await monitor.poll();
    expect(events, "no transition, so no event").toHaveLength(0);

    reported = "banned";
    for (let i = 0; i < 5; i += 1) await monitor.poll();
    expect(events).toHaveLength(1);

    reported = "up";
    for (let i = 0; i < 5; i += 1) await monitor.poll();
    expect(events).toHaveLength(2);

    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(["up->banned", "banned->up"]);
  });

  it("the payload is exactly CONTRACTS.md section 4's shape", async () => {
    const registry = new LineRegistry(registryConfig({ lines: [LINES[0] as LineDefinition] }));
    const monitor = new LineHealthMonitor(registry, async () => "degraded", () => new Date("2026-08-02T12:00:00.000Z"));
    const events: LineHealthChanged[] = [];
    monitor.on((e) => events.push(e));

    await monitor.poll();
    expect(events[0]).toEqual({
      line_id: "line_a1",
      from: "up",
      to: "degraded",
      at: "2026-08-02T12:00:00.000Z",
    });
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(["at", "from", "line_id", "to"]);
  });

  it("an unreachable health source degrades rather than reporting up", async () => {
    const registry = new LineRegistry(registryConfig({ lines: [LINES[0] as LineDefinition] }));
    const monitor = new LineHealthMonitor(registry, async () => {
      throw new Error("unreachable");
    });
    await monitor.poll();
    expect(registry.statusOf("line_a1")).toBe("degraded");
  });

  it("keeps a transition history and supports unsubscribing", async () => {
    const registry = new LineRegistry(registryConfig({ lines: [LINES[0] as LineDefinition] }));
    let reported: "up" | "banned" = "banned";
    const monitor = new LineHealthMonitor(registry, async () => reported);
    const seen: LineHealthChanged[] = [];
    const off = monitor.on((e) => seen.push(e));

    await monitor.poll();
    off();
    reported = "up";
    await monitor.poll();

    expect(seen).toHaveLength(1);
    expect(monitor.history).toHaveLength(2);
  });

  it("the poll interval is configuration", () => {
    expect(loadLineHealthConfig({} as NodeJS.ProcessEnv).pollIntervalMs).toBe(60_000);
    expect(loadLineHealthConfig({ LINE_HEALTH_POLL_INTERVAL_MS: "5000" } as NodeJS.ProcessEnv).pollIntervalMs).toBe(5000);
    expect(() => loadLineHealthConfig({ LINE_HEALTH_POLL_INTERVAL_MS: "-1" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("automatic downgrade — green and late beats blue and never", () => {
  it("with the mock banned, the send still succeeds via the fallback in the same call", async () => {
    mock.config.mode = "banned";
    const { routed, fallback } = harness();

    const result: SendResult = await routed.send(message("usr_downgrade", "downgrade-1"));

    // It SUCCEEDED. No throw, no retry queue, no tomorrow.
    expect(result.message_id).toMatch(/^omsg_stub_/);
    expect(fallback.sent).toHaveLength(1);

    // And the result records which path it took: `provider` is the frozen contract's own
    // field, and it is the fallback's.
    expect(result.provider).toBe("mock");
    expect(result.line_id).toBe("line_fallback");

    const route = routed.routes.at(-1);
    expect(route?.path).toBe("fallback");
    expect(route?.reason).toBe("primary_failed");
  });

  it("a known-banned line does not get a doomed attempt first", async () => {
    const { routed, registry, fallback } = harness();
    registry.assign("usr_known");
    registry.setStatus("line_a1", "banned");
    mock.recorder.clear();

    await routed.send(message("usr_known", "known-banned-1"));

    // Retrying a banned line is what deepens the ban, so nothing was sent to it.
    expect(mock.recorder.all()).toHaveLength(0);
    expect(fallback.sent).toHaveLength(1);
    expect(routed.routes.at(-1)?.reason).toBe("line_unhealthy");
  });

  it("a ban migrates every user off the line — the blast radius acts, not just reports", async () => {
    mock.config.mode = "banned";
    const { routed, registry } = harness({ registry: { usersPerLine: 5 } });
    registry.assign("usr_a");
    registry.assign("usr_b");
    registry.assign("usr_c");
    expect(registry.usersOn("line_a1")).toEqual(["usr_a", "usr_b", "usr_c"]);

    await routed.send(message("usr_a", "ban-migrate-1"));

    expect(registry.usersOn("line_a1")).toEqual([]);
    expect(registry.usersOn("line_a2")).toEqual(["usr_a", "usr_b", "usr_c"]);
    expect(registry.statusOf("line_a1")).toBe("banned");
  });

  it("degradeOn is configurable — a degraded line can be left alone or fled", async () => {
    const { routed, registry, fallback } = harness({ routed: { degradeOn: ["degraded", "banned"] } });
    registry.assign("usr_deg");
    registry.setStatus("line_a1", "degraded");
    await routed.send(message("usr_deg", "deg-1"));
    expect(fallback.sent).toHaveLength(1);

    const strict = harness({ routed: { degradeOn: ["banned"] } });
    strict.registry.assign("usr_deg2");
    strict.registry.setStatus("line_a1", "degraded");
    await strict.routed.send(message("usr_deg2", "deg-2"));
    expect(strict.fallback.sent, "degraded is not in degradeOn, so the primary is used").toHaveLength(0);
  });

  it("the downgrade decision, class by class — only line-level failures reach the fallback", async () => {
    // Pins the whole rule directly. An earlier revision had two overlapping guards, and
    // deleting one changed no test — redundant logic that reads as protected when only
    // the other branch is doing the work.
    const cases: [string, ChannelError, "fallback" | "throws"][] = [
      ["line_banned", new LineBannedError("line_a1"), "fallback"],
      ["line_unavailable", new LineUnavailableError("line_a1"), "fallback"],
      ["rate_limited", new RateLimitedError(30), "throws"],
      ["provider_unavailable", new UpstreamError("provider_unavailable", true), "throws"],
      ["malformed_response", new UpstreamError("malformed_response", false), "throws"],
      ["unauthorized", new UpstreamError("unauthorized", false), "throws"],
      ["unsupported_capability", new CapabilityError("groups", "nope"), "throws"],
      ["empty_message", new EmptyMessageError(), "throws"],
    ];

    for (const [label, error, expected] of cases) {
      const failing: Channel = {
        send: async () => {
          throw error;
        },
        capabilities: async () => ({
          tapbacks: true, images: true, groups: false, typing: false,
          richlinks: true, contact_cards: true, threading: true,
        }),
        health: async () => ({ status: "up" as const, line_id: "line_a1", checked_at: new Date().toISOString() }),
        normalizeInbound: () => {
          throw new Error("unused");
        },
      };
      const h = harness({ primary: failing });
      if (expected === "fallback") {
        await h.routed.send(message(`usr_${label}`, `dd-${label}`));
        expect(h.fallback.sent, label).toHaveLength(1);
        expect(h.routed.routes.at(-1)?.path, label).toBe("fallback");
      } else {
        await expect(h.routed.send(message(`usr_${label}`, `dd-${label}`)), label).rejects.toBe(error);
        expect(h.fallback.sent, label).toHaveLength(0);
      }
    }
  });

  it("a retryable failure is NOT silently downgraded", async () => {
    // Rate limiting is not a line problem. Burning the fallback on it would hide a real
    // signal and spend a second provider's quota on our own throttling.
    mock.config.mode = "ratelimited";
    const { routed, fallback } = harness();
    await expect(routed.send(message("usr_rl", "rl-1"))).rejects.toThrow();
    expect(fallback.sent).toHaveLength(0);
  });
});

describe("rotation — the re-introduction", () => {
  it("does NOT introduce on a user's first ever message — there was no previous number", async () => {
    // The preamble says "same conversation, new bubbles". For a brand-new user that is a
    // false statement about their own history, in the product's voice. Track D also sends
    // a genuine first-contact message with a contact card; this would land on top of it.
    const { routed, registry } = harness();
    await routed.send(message("usr_brand_new", "new-1"));

    const parts = (mock.recorder.last()?.body as { message: { parts: { type: string; text: string }[] } }).message.parts;
    expect(parts, "a first-ever send must carry only the caller's blocks").toHaveLength(1);
    expect(parts[0]?.text).toBe("3 people are waiting on you.");
    expect(routed.routes.at(-1)?.introduced).toBe(false);
    expect(registry.needsIntroduction("usr_brand_new", "line_a1")).toBe(false);
  });

  it("leads with 'new number' after a rotation, and only on the first message from it", async () => {
    const { routed, registry } = harness();

    // Place the user first, then rotate. This is the shape that actually produces the
    // preamble: an existing user whose number changed.
    await routed.send(message("usr_rot", "rot-0"));
    const before = registry.lineFor("usr_rot");
    registry.migrate("usr_rot", "rotation");
    const after = registry.lineFor("usr_rot");
    expect(after).not.toBe(before);

    mock.recorder.clear();
    await routed.send(message("usr_rot", "rot-1"));
    const firstParts = (mock.recorder.last()?.body as { message: { parts: { type: string; text: string }[] } }).message.parts;
    expect(firstParts).toHaveLength(2);
    expect(firstParts[0]?.text).toBe(DEFAULT_INTRODUCTION);
    expect(routed.routes.at(-1)?.introduced).toBe(true);

    mock.recorder.clear();
    await routed.send(message("usr_rot", "rot-2"));
    const secondParts = (mock.recorder.last()?.body as { message: { parts: { type: string }[] } }).message.parts;
    expect(secondParts, "only the first message from the new line").toHaveLength(1);
    expect(routed.routes.at(-1)?.introduced).toBe(false);
  });

  it("a health migration also introduces — the user's number changed either way", async () => {
    const { routed, registry } = harness();
    await routed.send(message("usr_health", "health-0"));
    registry.migrate("usr_health", "health");

    mock.recorder.clear();
    await routed.send(message("usr_health", "health-1"));
    const parts = (mock.recorder.last()?.body as { message: { parts: { text: string }[] } }).message.parts;
    expect(parts[0]?.text).toBe(DEFAULT_INTRODUCTION);
  });

  it("a failed send does not burn the introduction", async () => {
    // Marking before the send succeeds would leave a user permanently un-introduced —
    // they would silently receive messages from an unknown number forever.
    const { routed, registry } = harness();
    // Place then rotate, so an introduction is genuinely due — a first-ever assignment
    // owes no introduction at all.
    await routed.send(message("usr_burn", "burn-0"));
    registry.migrate("usr_burn", "rotation");
    const line = registry.lineFor("usr_burn") ?? "";
    expect(registry.needsIntroduction("usr_burn", line)).toBe(true);

    mock.config.mode = "ratelimited";
    await expect(routed.send(message("usr_burn", "burn-1"))).rejects.toThrow();
    expect(registry.needsIntroduction("usr_burn", line), "a failed send must not consume it").toBe(true);

    mock.config.mode = "up";
    await routed.send(message("usr_burn", "burn-2"));
    expect(registry.needsIntroduction("usr_burn", line)).toBe(false);
  });

  it("migration is recorded as an event with a reason, not a silent reassignment", () => {
    const registry = new LineRegistry(registryConfig());
    registry.assign("usr_m");
    const migration = registry.migrate("usr_m", "rotation");
    expect(migration.from).toBe("line_a1");
    expect(migration.to).toBe("line_a2");
    expect(migration.reason).toBe("rotation");
    expect(migration.at).toMatch(/Z$/);
  });

  it("the introduction text is configurable", () => {
    expect(loadRoutedChannelConfig({} as NodeJS.ProcessEnv).introductionText).toBe(DEFAULT_INTRODUCTION);
    expect(loadRoutedChannelConfig({ LINE_INTRODUCTION_TEXT: "hi, new number" } as NodeJS.ProcessEnv).introductionText).toBe(
      "hi, new number",
    );
  });
});

describe("idempotency holds at the layer the caller actually holds", () => {
  it("a retry after the line goes banned does not text the user twice", async () => {
    // The exact path the review found. The primary adapter has its own cache, but a
    // degradeOn line routes straight to the fallback without consulting it — so without
    // keying HERE, send(K), ban, retry(K) texts a real person twice, in one process,
    // with no restart involved.
    const { routed, registry, fallback } = harness();
    const msg = message("usr_dbl", "double-text-K");

    const first = await routed.send(msg);
    expect(mock.recorder.all()).toHaveLength(1);
    expect(fallback.sent).toHaveLength(0);

    registry.setStatus(registry.lineFor("usr_dbl") ?? "", "banned");

    const second = await routed.send(msg);
    expect(second, "same key must return the first result").toEqual(first);
    expect(fallback.sent, "the fallback must not have been used at all").toHaveLength(0);
    expect(mock.recorder.all(), "and no second request went anywhere").toHaveLength(1);
  });

  it("the same key on the fallback path is also served once", async () => {
    const { routed, registry, fallback } = harness();
    registry.assign("usr_fb");
    registry.setStatus("line_a1", "banned");
    const msg = message("usr_fb", "fallback-K");

    const first = await routed.send(msg);
    const second = await routed.send(msg);
    expect(fallback.sent).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("concurrent sends with one key collapse to a single delivery", async () => {
    const { routed, fallback } = harness();
    const msg = message("usr_conc", "concurrent-K");
    const [a, b, c] = await Promise.all([routed.send(msg), routed.send(msg), routed.send(msg)]);
    expect(mock.recorder.all()).toHaveLength(1);
    expect(fallback.sent).toHaveLength(0);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("a DIFFERENT key still sends, and a FAILED send is not cached", async () => {
    const { routed } = harness();
    await routed.send(message("usr_k", "key-1"));
    await routed.send(message("usr_k", "key-2"));
    expect(mock.recorder.all()).toHaveLength(2);

    mock.config.mode = "ratelimited";
    await expect(routed.send(message("usr_k", "key-3"))).rejects.toThrow();
    mock.config.mode = "up";
    // Not cached, so the retry is allowed through — a request that failed must stay
    // retryable.
    await routed.send(message("usr_k", "key-3"));
    expect(mock.recorder.all()).toHaveLength(4);
  });
});

describe("RoutedChannel guards the inbound boundary it exposes to Track D", () => {
  // Injected primary that does NOT guard, so the assertion is about RoutedChannel's own
  // boundary rather than about LinqChannel's. With LinqChannel as primary these tests
  // pass whether or not RoutedChannel guards — the downstream path raises the same
  // errors — which would make the guard look protected while being dead weight.
  function unguardedPrimary(): Channel {
    return {
      send: async () => ({ message_id: "x", provider: "mock", protocol: "sms", line_id: "line_a1" }),
      capabilities: async () => ({
        tapbacks: true, images: true, groups: false, typing: false,
        richlinks: true, contact_cards: true, threading: true,
      }),
      health: async () => ({ status: "up" as const, line_id: "line_a1", checked_at: "2026-08-02T12:00:00.000Z" }),
      normalizeInbound: () => {
        throw new Error("the primary was reached — RoutedChannel failed to guard");
      },
    };
  }

  const raw = '{"id":"lmsg_1","line_id":"line_a1","from":"+15551234567","type":"message","text":"2"}';

  it("an absent or duplicated signature header is a SignatureError, not a crash", () => {
    const { routed } = harness({ primary: unguardedPrimary() });
    const headers: (string | string[] | undefined)[] = [undefined, ["sha256=a", "sha256=b"]];

    for (const sig of headers) {
      const err = (() => {
        try {
          routed.normalizeInbound(raw, sig);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err, String(sig)).toBeInstanceOf(SignatureError);
      expect(err, "a TypeError here is a 500 in Track D's route handler").not.toBeInstanceOf(TypeError);
    }
  });

  it("a parsed object is a RawBodyRequiredError at this layer too", () => {
    const { routed } = harness({ primary: unguardedPrimary() });
    expect(() => routed.normalizeInbound({ id: "lmsg_1" }, "sha256=x")).toThrow(RawBodyRequiredError);
  });
});

describe("state survives a restart, because re-introducing everyone is a user-visible bug", () => {
  it("snapshot and restore preserve assignments, introductions and health", async () => {
    const { registry, routed } = harness();
    await routed.send(message("usr_snap", "snap-1"));
    registry.setStatus("line_a2", "degraded");

    const snapshot = registry.snapshot();
    const restored = new LineRegistry(registryConfig());
    restored.restore(snapshot);

    expect(restored.lineFor("usr_snap")).toBe("line_a1");
    expect(restored.needsIntroduction("usr_snap", "line_a1")).toBe(false);
    expect(restored.statusOf("line_a2")).toBe("degraded");
    expect(restored.usersOn("line_a1")).toEqual(["usr_snap"]);
  });
});

describe("every open sales-call question is a named config value", () => {
  it("CONTRACTS.md section 11 items 3-7 each map to config, not a constant", () => {
    const env = {
      CHANNEL_RATE_LIMIT_MAX: "10",
      CHANNEL_RATE_LIMIT_INTERVAL_MS: "30000",
      CHANNEL_RATE_LIMIT_BEHAVIOUR: "reject",
      LINE_BAN_COVERED_BY_SLA: "true",
      LINE_STICKY: "false",
      LINE_ASSUME_ROTATION_NOTICE: "true",
      LINE_USERS_PER_LINE: "3",
      LINE_POOL: "line_x=+1555",
    } as NodeJS.ProcessEnv;

    // item 3 — real rate limits
    const rate = loadLinqChannelConfig(env).rateLimit;
    expect(rate).toEqual({ maxPerInterval: 10, intervalMs: 30_000, behaviour: "reject" });

    const lines = loadLineRegistryConfig(env);
    // item 4 — does the SLA cover a line-level ban?
    expect(lines.banCoveredBySla).toBe(true);
    // item 5 — is a line sticky indefinitely?
    expect(lines.sticky).toBe(false);
    // item 6 — are we notified before a number rotates?
    expect(lines.assumeRotationNotice).toBe(true);
    // item 7 — tenants per line
    expect(lines.usersPerLine).toBe(3);
    expect(lines.lines).toEqual([{ line_id: "line_x", handle: "+1555" }]);
  });

  it("the defaults are the pessimistic reading of each unanswered question", () => {
    const lines = loadLineRegistryConfig({} as NodeJS.ProcessEnv);
    // Assume the SLA does NOT cover a line ban, assume stickiness is not guaranteed,
    // assume no rotation notice, keep tenancy low. Each default is the assumption that
    // costs us least if it turns out to be wrong.
    expect(lines.banCoveredBySla).toBe(false);
    expect(lines.assumeRotationNotice).toBe(false);
    expect(lines.usersPerLine).toBe(5);
    expect(loadRoutedChannelConfig({} as NodeJS.ProcessEnv).degradeOn).toEqual(["banned"]);
  });

  it("rejects an unparseable value rather than falling back to a default", () => {
    expect(() => loadLineRegistryConfig({ LINE_STICKY: "sometimes" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadRoutedChannelConfig({ LINE_DEGRADE_ON: "on_fire" } as NodeJS.ProcessEnv)).toThrow();
  });
});
