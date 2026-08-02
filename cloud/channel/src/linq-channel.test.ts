import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer, DEV_TOKEN, type MockLinqConfig, type MockLinqServer, type MockMode } from "../../mock-linq/src/server.js";
import type { Capabilities, OutboundMessage, SendResult } from "../../shared/src/contracts.js";
import {
  LinqChannel,
  loadLinqChannelConfig,
  parseHealth,
  slugLooksBanned,
  type LinqChannelConfig,
} from "./linq-channel.js";
import {
  CapabilityError,
  ChannelError,
  EmptyMessageError,
  LineBannedError,
  LineUnavailableError,
  RateLimitedError,
  UpstreamError,
} from "./errors.js";
import { RateLimiter } from "./rate-limiter.js";

const REPO_ROOT = new URL("../../../", import.meta.url);

function fixture(name: string): OutboundMessage {
  return JSON.parse(readFileSync(new URL(`contracts/fixtures/outbound/${name}`, REPO_ROOT), "utf8"));
}

function transcript(name: string): { request?: { body?: Record<string, unknown> } } {
  return JSON.parse(readFileSync(new URL(`contracts/transcripts/linq/${name}`, REPO_ROOT), "utf8"));
}

const BRIEF = fixture("brief_message.json");
const CONTACT_CARD = fixture("first_contact_card.json");
const SEND_TEXT_200 = transcript("send_text_200.json");

// CONTRACTS.md section 9: Track C's channel test server is 3032.
const CHANNEL_TEST_PORT = 3032;
const RECIPIENT = "+15551234567";
const FROM = "+15550100123";

// The mock runs on a real socket here rather than through inject(), because the point of
// this suite is that the adapter's HTTP client works — LINQ_BASE_URL, headers, body
// serialization and all. Testing the adapter against an in-process fake would prove
// nothing about the wire.
let mock: MockLinqServer;

function mockConfig(mode: MockMode): MockLinqConfig {
  return {
    port: CHANNEL_TEST_PORT,
    host: "127.0.0.1",
    mode,
    lineId: "line_a1",
    fromHandle: FROM,
    webhookSecret: "dev-secret-change-me",
    webhookUrl: null,
    expectedToken: DEV_TOKEN,
    retryAfterSeconds: 42,
    pathPrefix: "/api/partner/v3",
    logLevel: "silent",
  };
}

/**
 * Switches fault-injection mode on the running mock. The mock reads `config.mode` per
 * request, so this needs no restart — and must not use one: tearing the listener down
 * and rebinding the same port leaves undici holding a pooled socket to a dead server,
 * and the next send fails as a transport error rather than exercising the mode.
 */
function useMode(mode: MockMode): void {
  mock.config.mode = mode;
}

beforeAll(async () => {
  mock = buildServer(mockConfig("up"));
  await mock.app.listen({ port: CHANNEL_TEST_PORT, host: "127.0.0.1" });
});

afterAll(async () => {
  await mock.app.close();
});

beforeEach(() => {
  useMode("up");
  mock.recorder.clear();
});

function channelConfig(overrides: Partial<LinqChannelConfig> = {}): LinqChannelConfig {
  return {
    ...loadLinqChannelConfig({
      LINQ_BASE_URL: `http://127.0.0.1:${CHANNEL_TEST_PORT}/api/partner/v3`,
      LINQ_API_TOKEN: DEV_TOKEN,
      LINQ_FROM_HANDLE: FROM,
      LINQ_LINE_ID: "line_a1",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

function channel(
  overrides: Partial<LinqChannelConfig> = {},
  deps: { handles?: string[]; limiter?: RateLimiter } = {},
): LinqChannel {
  return new LinqChannel(channelConfig(overrides), {
    resolveHandles: () => deps.handles ?? [RECIPIENT],
    ...(deps.limiter === undefined ? {} : { limiter: deps.limiter }),
  });
}


/** Stands up a throwaway server that answers POST /chats with a fixed status and body,
 *  so error mapping can be tested against shapes the mock deliberately does not serve. */
async function withBody(status: number, body: unknown, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(3034, "127.0.0.1", done));
  try {
    await fn("http://127.0.0.1:3034/api/partner/v3");
  } finally {
    await new Promise<void>((done, fail) => server.close((e: Error | undefined) => (e ? fail(e) : done())));
  }
}

/** A 503 with a body no vocabulary recognizes. */
async function withUnclassified503(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  await withBody(503, { error: "something_we_have_never_seen", line_id: "line_a1" }, fn);
}

function lastBody(): Record<string, unknown> {
  const last = mock.recorder.last();
  expect(last, "no request reached the mock").not.toBeNull();
  const body = last?.body;
  expect(typeof body).toBe("object");
  return body as Record<string, unknown>;
}

describe("LinqChannel — round trip against the mock", () => {
  it("sends brief_message.json and produces a SendResult", async () => {
    const result: SendResult = await channel().send(BRIEF);

    expect(result.provider).toBe("linq");
    expect(result.protocol).toBe("imessage");
    expect(result.message_id).toMatch(/^lmsg_/);
    expect(result.line_id).toBe("line_a1");
    // The frozen SendResult and nothing else: no trace_id, no status, no parts.
    expect(Object.keys(result).sort()).toEqual(["line_id", "message_id", "protocol", "provider"]);
  });

  it("puts a request on the wire matching the transcript's recorded request", async () => {
    await channel().send(BRIEF);

    const recorded = mock.recorder.last();
    expect(recorded?.method).toBe("POST");
    expect(recorded?.path).toBe("/api/partner/v3/chats");
    expect(recorded?.headers.authorization).toBe(`Bearer ${DEV_TOKEN}`);

    const expectedShape = SEND_TEXT_200.request?.body;
    const body = lastBody();
    // Same envelope as the recorded request: same keys, same from/to shape, a single
    // text part, protocol auto. The text differs because the fixture's brief differs.
    expect(Object.keys(body).sort()).toEqual(Object.keys(expectedShape ?? {}).sort());
    expect(body.from).toBe(expectedShape?.from);
    expect(body.to).toEqual(expectedShape?.to);

    const message = body.message as Record<string, unknown>;
    const expectedMessage = expectedShape?.message as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(Object.keys(expectedMessage).sort());
    expect(message.protocol).toBe("auto");

    const parts = message.parts as { type: string; text: string }[];
    const expectedParts = expectedMessage.parts as { type: string }[];
    expect(parts).toHaveLength(expectedParts.length);
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toBe(BRIEF.blocks[0]?.type === "text" ? BRIEF.blocks[0].text : undefined);
  });

  it("sends first_contact_card.json as a text part AND a contact_card part", async () => {
    await channel().send(CONTACT_CARD);

    const message = lastBody().message as { parts: Record<string, unknown>[] };
    expect(message.parts).toHaveLength(2);
    expect(message.parts[0]).toEqual({
      type: "text",
      text: "hey — this is Boi. save me so i don't end up in your filtered messages. when the Mac app is set up, text me your pairing code.",
    });
    expect(message.parts[1]).toEqual({
      type: "contact_card",
      contact: { name: "Boi", handle: "+15550100123" },
    });
  });

  it("maps an image block to a media part", async () => {
    const msg: OutboundMessage = {
      schema_version: "outbound.v1",
      user_id: "usr_demo0001",
      idempotency_key: "image-usr_demo0001-1",
      blocks: [{ type: "image", url: "https://example.test/card.png", alt: "your week" }],
    };
    await channel().send(msg);

    const message = lastBody().message as { parts: Record<string, unknown>[] };
    expect(message.parts).toEqual([{ type: "media", url: "https://example.test/card.png" }]);
  });

  it("LINQ_BASE_URL drives the target — a bad base URL never reaches the mock", async () => {
    const wrong = channel({ baseUrl: `http://127.0.0.1:${CHANNEL_TEST_PORT}` });
    await expect(wrong.send(BRIEF)).rejects.toBeInstanceOf(UpstreamError);
    // It 404s at the mock, exactly as it would in production against the wrong base.
    expect(mock.recorder.last()?.path).toBe("/chats");
  });
});

describe("LinqChannel — typed errors", () => {
  it("banned produces LineBannedError carrying the line, not a generic throw", async () => {
    useMode("banned");
    const c = channel();
    await expect(c.send(BRIEF)).rejects.toBeInstanceOf(LineBannedError);

    const err = await c.send({ ...BRIEF, idempotency_key: "banned-probe-2" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineBannedError);
    if (!(err instanceof LineBannedError)) throw new Error("unreachable");
    expect(err.code).toBe("line_banned");
    expect(err.lineId).toBe("line_a1");
    expect(err.retryable).toBe(false);
  });

  it("ratelimited produces RateLimitedError carrying the Retry-After value", async () => {
    useMode("ratelimited");
    const err = await channel()
      .send(BRIEF)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitedError);
    if (!(err instanceof RateLimitedError)) throw new Error("unreachable");
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.local).toBe(false);
  });

  it("a rejected token produces UpstreamError, not a silent success", async () => {
    const err = await channel({ token: "not-the-token" })
      .send(BRIEF)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    if (!(err instanceof UpstreamError)) throw new Error("unreachable");
    expect(err.code).toBe("unauthorized");
    expect(err.diagnostic.status).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it("degraded is a successful send over sms, not an error", async () => {
    useMode("degraded");
    const result = await channel().send(BRIEF);
    expect(result.protocol).toBe("sms");
  });
});

describe("LinqChannel — the error surface is provider-neutral", () => {
  it("no error code is a provider slug or an HTTP status", async () => {
    // The audit that prompted this: `code` used to carry Linq's own slug and
    // `http_<status>`, while the README told Track D to branch on it. The key-set test on
    // SendResult and the filename grep were both blind to it.
    const NEUTRAL = new Set([
      "line_banned",
      "line_unavailable",
      "rate_limited",
      "unauthorized",
      "provider_unavailable",
      "malformed_response",
      "transport",
      "no_recipient",
      "unsupported_capability",
      "empty_message",
    ]);

    const collected: ChannelError[] = [];
    const push = async (fn: () => Promise<unknown>) => {
      const e = await fn().catch((x: unknown) => x);
      if (e instanceof ChannelError) collected.push(e);
    };

    useMode("banned");
    await push(() => channel().send({ ...BRIEF, idempotency_key: "neutral-1" }));
    useMode("ratelimited");
    await push(() => channel().send({ ...BRIEF, idempotency_key: "neutral-2" }));
    useMode("up");
    await push(() => channel({ token: "wrong" }).send({ ...BRIEF, idempotency_key: "neutral-3" }));
    await push(() => channel({ baseUrl: "http://127.0.0.1:3039/api/partner/v3" }).send({ ...BRIEF, idempotency_key: "neutral-4" }));
    await push(() => channel({}, { handles: [RECIPIENT, "+15559998888"] }).send({ ...BRIEF, idempotency_key: "neutral-5" }));

    expect(collected.length).toBeGreaterThanOrEqual(5);
    for (const err of collected) {
      expect(NEUTRAL, `code '${err.code}' is not in the neutral set`).toContain(err.code);
      expect(err.code).not.toMatch(/^http_/);
      expect(typeof err.retryable).toBe("boolean");
    }
  });

  it("the provider slug survives for logs, in diagnostic, not in code", async () => {
    useMode("banned");
    const err = await channel().send(BRIEF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineBannedError);
    if (!(err instanceof LineBannedError)) throw new Error("unreachable");
    expect(err.diagnostic.slug).toBe("line_banned");
    expect(err.diagnostic.status).toBe(503);
    expect(err.code).toBe("line_banned");
  });

  it("recognizes a ban whatever the provider called it", () => {
    for (const slug of ["line_banned", "LINE_BANNED", "account_suspended", "line.blocked", "handle-disabled", "terminated"]) {
      expect(slugLooksBanned(slug), slug).toBe(true);
    }
    for (const slug of ["line_degraded", "upstream", "rate_limited", null, "", "abandoned"]) {
      expect(slugLooksBanned(slug), String(slug)).toBe(false);
    }
  });

  it("an unclassifiable 503 is non-retryable, not a generic retryable error", async () => {
    // Previously a 503 whose body was not exactly {"error":"line_banned"} fell through to
    // UpstreamError, which the README marks retryable — so Track D would have retried a
    // line that may well have been banned.
    await withUnclassified503(async (baseUrl) => {
      const err = await channel({ baseUrl }).send(BRIEF).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LineUnavailableError);
      if (!(err instanceof LineUnavailableError)) throw new Error("unreachable");
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("line_unavailable");
    });
  });

  it("a differently-worded ban body still raises LineBannedError", async () => {
    await withBody(503, { error: "account_suspended", line_id: "line_z9" }, async (baseUrl) => {
      const err = await channel({ baseUrl }).send(BRIEF).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LineBannedError);
      if (!(err instanceof LineBannedError)) throw new Error("unreachable");
      expect(err.lineId).toBe("line_z9");
      expect(err.retryable).toBe(false);
    });
  });

  it("a platform 500 is retryable — it is not a line-level failure", async () => {
    await withBody(500, { error: "internal" }, async (baseUrl) => {
      const err = await channel({ baseUrl }).send(BRIEF).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UpstreamError);
      if (!(err instanceof UpstreamError)) throw new Error("unreachable");
      expect(err.code).toBe("provider_unavailable");
      expect(err.retryable).toBe(true);
      expect(err.diagnostic.slug).toBe("internal");
    });
  });
});

describe("LinqChannel — capabilities are configuration", () => {
  it("CHANNEL_CAPABILITIES overrides the defaults", () => {
    const base = loadLinqChannelConfig({} as NodeJS.ProcessEnv).capabilities;
    expect(base.groups).toBe(false);
    expect(base.images).toBe(true);

    const overridden = loadLinqChannelConfig({
      CHANNEL_CAPABILITIES: "groups=1, images=false ,threading=0",
    } as NodeJS.ProcessEnv).capabilities;
    expect(overridden.groups).toBe(true);
    expect(overridden.images).toBe(false);
    expect(overridden.threading).toBe(false);
    expect(overridden.contact_cards).toBe(true);
  });

  it("refuses an unknown capability or an unparseable value rather than ignoring it", () => {
    const load = (v: string) => () => loadLinqChannelConfig({ CHANNEL_CAPABILITIES: v } as NodeJS.ProcessEnv);
    expect(load("carrier_pigeon=1")).toThrow(/unknown capability/);
    expect(load("groups=maybe")).toThrow(/invalid value/);
    expect(load("groups")).toThrow(/expected key=value/);
  });

  it("documents honestly which capabilities gate anything: tapbacks, richlinks and typing do not", async () => {
    // Flipping the three dead flags changes nothing on the wire. Asserted rather than
    // left implied, so "negotiated before use" is not read as a guarantee for them.
    const c = channel({
      capabilities: { ...loadLinqChannelConfig({} as NodeJS.ProcessEnv).capabilities, tapbacks: false, richlinks: false, typing: false },
    });
    await c.send({ ...BRIEF, idempotency_key: "dead-flags-1" });
    const withFlagsOff = JSON.stringify(lastBody());

    mock.recorder.clear();
    await channel().send({ ...BRIEF, idempotency_key: "dead-flags-2" });
    expect(JSON.stringify(lastBody())).toBe(withFlagsOff);
  });
});

describe("LinqChannel — idempotency", () => {
  it("two sends with the same idempotency_key reach the mock exactly once", async () => {
    const c = channel();
    const first = await c.send(BRIEF);
    const second = await c.send(BRIEF);

    expect(mock.recorder.all()).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.message_id).toBe(first.message_id);
  });

  it("concurrent sends with the same key collapse to one request", async () => {
    const c = channel();
    const [a, b, d] = await Promise.all([c.send(BRIEF), c.send(BRIEF), c.send(BRIEF)]);

    expect(mock.recorder.all()).toHaveLength(1);
    expect(a.message_id).toBe(b.message_id);
    expect(b.message_id).toBe(d.message_id);
  });

  it("a DIFFERENT key does send again — the cache is keyed, not a blanket mute", async () => {
    const c = channel();
    const first = await c.send(BRIEF);
    const second = await c.send({ ...BRIEF, idempotency_key: "brief-usr_demo0001-2026-08-03" });

    expect(mock.recorder.all()).toHaveLength(2);
    expect(second.message_id).not.toBe(first.message_id);
  });

  it("a failed send is not cached — the retry is allowed to reach the provider", async () => {
    useMode("ratelimited");
    const c = channel();
    await expect(c.send(BRIEF)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(c.send(BRIEF)).rejects.toBeInstanceOf(RateLimitedError);
    expect(mock.recorder.all()).toHaveLength(2);
  });
});

describe("LinqChannel — capability negotiation", () => {
  const caps = (overrides: Partial<Capabilities>): Capabilities => ({
    tapbacks: true,
    images: true,
    groups: false,
    typing: false,
    richlinks: true,
    contact_cards: true,
    threading: true,
    ...overrides,
  });

  it("refuses a group send rather than attempting it when groups is false", async () => {
    const c = channel({ capabilities: caps({ groups: false }) }, { handles: [RECIPIENT, "+15559998888"] });
    const err = await c.send(BRIEF).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CapabilityError);
    if (!(err instanceof CapabilityError)) throw new Error("unreachable");
    expect(err.capability).toBe("groups");
    // Refused BEFORE the wire. A group send that quietly fans out is a consent problem.
    expect(mock.recorder.all()).toHaveLength(0);
  });

  it("attempts a multi-recipient send when groups is true", async () => {
    const c = channel({ capabilities: caps({ groups: true }) }, { handles: [RECIPIENT, "+15559998888"] });
    await c.send(BRIEF);
    expect(lastBody().to).toEqual([RECIPIENT, "+15559998888"]);
  });

  it("degrades silently: no contact_cards means the card is dropped and the text still sends", async () => {
    const c = channel({ capabilities: caps({ contact_cards: false }) });
    await c.send(CONTACT_CARD);

    const message = lastBody().message as { parts: { type: string }[] };
    expect(message.parts.map((p) => p.type)).toEqual(["text"]);
  });

  it("degrades silently: no images means the media part is dropped", async () => {
    const c = channel({ capabilities: caps({ images: false }) });
    await c.send({
      schema_version: "outbound.v1",
      user_id: "usr_demo0001",
      idempotency_key: "mixed-usr_demo0001-1",
      blocks: [
        { type: "text", text: "hello" },
        { type: "image", url: "https://example.test/card.png" },
      ],
    });

    const message = lastBody().message as { parts: { type: string }[] };
    expect(message.parts.map((p) => p.type)).toEqual(["text"]);
  });

  it("threading is negotiated: reply_to is sent when supported and dropped when not", async () => {
    const replying: OutboundMessage = { ...BRIEF, idempotency_key: "reply-1", reply_to_message_id: "lmsg_01J8ZK" };

    await channel({ capabilities: caps({ threading: true }) }).send(replying);
    expect((lastBody().message as Record<string, unknown>).reply_to).toBe("lmsg_01J8ZK");

    mock.recorder.clear();
    await channel({ capabilities: caps({ threading: false }) }).send({ ...replying, idempotency_key: "reply-2" });
    expect((lastBody().message as Record<string, unknown>).reply_to).toBeUndefined();
  });

  it("refuses to send an empty message when every block degrades away", async () => {
    const c = channel({ capabilities: caps({ images: false }) });
    const err = await c
      .send({
        schema_version: "outbound.v1",
        user_id: "usr_demo0001",
        idempotency_key: "only-image-1",
        blocks: [{ type: "image", url: "https://example.test/card.png" }],
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmptyMessageError);
    expect(mock.recorder.all()).toHaveLength(0);
  });

  it("capabilities() hands out a copy a caller cannot mutate", async () => {
    const c = channel();
    const first = await c.capabilities();
    first.groups = true;
    expect((await c.capabilities()).groups).toBe(false);
  });
});

describe("LinqChannel — rate limiting", () => {
  it("delays when the configured limit is reached", async () => {
    const slept: number[] = [];
    let clock = 0;
    const limiter = new RateLimiter({
      maxPerInterval: 2,
      intervalMs: 1000,
      behaviour: "delay",
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    const c = channel({}, { limiter });

    await c.send({ ...BRIEF, idempotency_key: "limited-1" });
    await c.send({ ...BRIEF, idempotency_key: "limited-2" });
    expect(slept).toEqual([]);

    await c.send({ ...BRIEF, idempotency_key: "limited-3" });
    expect(slept).toEqual([1000]);
    expect(mock.recorder.all()).toHaveLength(3);
  });

  it("rejects with a LOCAL RateLimitedError when configured to reject", async () => {
    const limiter = new RateLimiter({ maxPerInterval: 1, intervalMs: 60_000, behaviour: "reject", now: () => 0 });
    const c = channel({}, { limiter });

    await c.send({ ...BRIEF, idempotency_key: "reject-1" });
    const err = await c.send({ ...BRIEF, idempotency_key: "reject-2" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitedError);
    if (!(err instanceof RateLimitedError)) throw new Error("unreachable");
    expect(err.local).toBe(true);
    expect(err.retryAfterSeconds).toBe(60);
    // The second send never reached the provider — that is the point of limiting locally.
    expect(mock.recorder.all()).toHaveLength(1);
  });

  it("the limit is configuration, with a conservative default", () => {
    const defaults = loadLinqChannelConfig({} as NodeJS.ProcessEnv).rateLimit;
    expect(defaults).toEqual({ maxPerInterval: 30, intervalMs: 60_000, behaviour: "delay" });

    const configured = loadLinqChannelConfig({
      CHANNEL_RATE_LIMIT_MAX: "5",
      CHANNEL_RATE_LIMIT_INTERVAL_MS: "1000",
      CHANNEL_RATE_LIMIT_BEHAVIOUR: "reject",
    } as NodeJS.ProcessEnv).rateLimit;
    expect(configured).toEqual({ maxPerInterval: 5, intervalMs: 1000, behaviour: "reject" });

    expect(() => loadLinqChannelConfig({ CHANNEL_RATE_LIMIT_BEHAVIOUR: "explode" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("LinqChannel — health", () => {
  it("maps the mock's line status in every mode", async () => {
    for (const [mode, status] of [
      ["up", "up"],
      ["degraded", "degraded"],
      ["banned", "banned"],
    ] as [MockMode, string][]) {
      useMode(mode);
      const health = await channel().health();
      expect(health.status, mode).toBe(status);
      expect(health.line_id).toBe("line_a1");
      expect(health.checked_at).toMatch(/Z$/);
    }
  });

  it("tolerates GET /lines shapes other than the spec's guess", () => {
    const at = "2026-08-02T12:00:00.000Z";
    const shapes: [string, unknown, string][] = [
      ["spec guess", { lines: [{ id: "line_a1", status: "up" }] }, "up"],
      ["bare array", [{ id: "line_a1", status: "active" }], "up"],
      ["data envelope", { data: [{ line_id: "line_a1", state: "suspended" }] }, "banned"],
      ["single object", { id: "line_a1", health: "throttled" }, "degraded"],
      ["nested line", { line: { id: "line_a1", status: "OK" } }, "up"],
    ];
    for (const [label, payload, expected] of shapes) {
      expect(parseHealth(payload, at).status, label).toBe(expected);
    }
    expect(parseHealth({ lines: [{ id: "line_a1" }] }, at).line_id).toBe("line_a1");
  });

  it("reports degraded — never up — when the response cannot be understood", () => {
    const at = "2026-08-02T12:00:00.000Z";
    for (const payload of [null, "nope", {}, { lines: [] }, { lines: [{ id: "x", status: "quantum" }] }]) {
      expect(parseHealth(payload, at).status).toBe("degraded");
    }
  });

  it("reports degraded rather than throwing when the provider is unreachable", async () => {
    const c = channel({ baseUrl: "http://127.0.0.1:3039/api/partner/v3" });
    const health = await c.health();
    expect(health.status).toBe("degraded");
    expect(health.line_id).toBeNull();
  });
});

describe("LinqChannel — the abstraction boundary", () => {
  it("normalizeInbound refuses rather than returning a partial message", () => {
    expect(() => channel().normalizeInbound({}, "sha256=x")).toThrow(/not_implemented/);
  });

  it("no Linq field survives into SendResult or ChannelHealth", async () => {
    const result = await channel().send({ ...BRIEF, idempotency_key: "leak-check-1" });
    expect(Object.keys(result).sort()).toEqual(["line_id", "message_id", "protocol", "provider"]);

    // trace_id is the clearest tell: the mock returns one on every send and it must not
    // appear anywhere above this line.
    const raw = JSON.parse(mock.recorder.last()?.raw_body ?? "{}");
    expect(raw).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("trace_id");
    expect(JSON.stringify(result)).not.toContain("parts");

    const health = await channel().health();
    expect(Object.keys(health).sort()).toEqual(["checked_at", "line_id", "status"]);
  });
});
