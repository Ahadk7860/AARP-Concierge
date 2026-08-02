// POST /v1/webhooks/{provider} — the two things Track C said would bite.
//
// Track D owns what happens to a normalized message; Track C owns getting there. These
// tests are about the handoff, which is where both reported gaps live: the raw bytes,
// and a header type Fastify makes wider than it looks.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import type {
  Capabilities,
  Channel,
  ChannelHealth,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "../../shared/src/index.js";
import {
  acquireSuiteLock,
  closePool,
  createUser,
  deleteUser,
  getPool,
  migrate,
  releaseSuiteLock,
  type UserScope,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import { makeLogger } from "./logging.js";
import { signatureHeader } from "./routes/webhook.js";

const pool = getPool();
const SECRET = "dev-secret-change-me";

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1560${String(1_000_000 + phoneCounter).slice(-7)}`;
}

/**
 * A stand-in for Track C's adapter, behaving the way Track C says the real one does:
 * verify a signature over the RAW BYTES, then parse.
 *
 * The foundation's `StubChannel.normalizeInbound` treats its first argument as an
 * already-parsed object, so it cannot exercise this path at all — recorded as a
 * contract gap in NOTES.md. This double is what the criterion actually needs, and it is
 * deliberately strict: hand it anything but a string and it throws, exactly like
 * `RawBodyRequiredError`.
 */
class RawBodyRequiredError extends Error {
  constructor() {
    super("RawBodyRequiredError: normalizeInbound needs the raw request bytes");
    this.name = "RawBodyRequiredError";
  }
}

function verifyingChannel(): Channel & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    async send(msg: OutboundMessage): Promise<SendResult> {
      sent.push(msg);
      return {
        message_id: `lmsg_${sent.length}`,
        provider: "mock",
        protocol: "imessage",
        line_id: "line_a1",
      };
    },
    async capabilities(): Promise<Capabilities> {
      return {
        tapbacks: true, images: true, groups: false, typing: true,
        richlinks: true, contact_cards: true, threading: true,
      };
    },
    async health(): Promise<ChannelHealth> {
      return { status: "up", line_id: "line_a1", checked_at: new Date().toISOString() };
    },
    normalizeInbound(rawBody: unknown, signature: string): InboundMessage {
      // THE ASSERTION THAT MATTERS. A parsed object cannot be verified: re-serialising
      // it moves key order and whitespace, so the digest never matches what was signed.
      if (typeof rawBody !== "string") throw new RawBodyRequiredError();

      const expected = `sha256=${createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex")}`;
      if (signature !== expected) throw new Error("bad_signature");

      const body = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        schema_version: "inbound.v1",
        provider: "mock",
        provider_message_id: String(body["provider_message_id"] ?? "mmsg_1"),
        line_id: "line_a1",
        from_handle: String(body["from_handle"] ?? "+15551234567"),
        user_id: (body["user_id"] as string | null) ?? null,
        received_at: new Date().toISOString(),
        kind: "text",
        text: (body["text"] as string | null) ?? null,
        reply_to_message_id: (body["reply_to_message_id"] as string | null) ?? null,
        protocol: "imessage",
        trace_id: null,
      };
    },
  };
}

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

let app: FastifyInstance;
let channel: ReturnType<typeof verifyingChannel>;
const cleanup: UserScope[] = [];

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate(pool);
  channel = verifyingChannel();
  app = buildServer({ channel, logger: makeLogger(new PassThrough()) });
  await app.ready();
}, 120_000);

afterAll(async () => {
  for (const scope of cleanup) {
    try {
      await deleteUser(scope);
    } catch {
      // already gone
    }
  }
  await app.close();
  await closePool();
  await releaseSuiteLock();
});

// ---------------------------------------------------------------------------

describe("the raw body reaches normalizeInbound", () => {
  it("verifies a signature computed over the exact bytes sent", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    cleanup.push(scope);

    // Deliberately awkward JSON: extra whitespace and a key order no serialiser would
    // reproduce. If the route re-serialised a parsed object, this signature would fail.
    const raw = `{  "text" : "2",\n  "user_id":"${scope.user_id}",  "provider_message_id":"mmsg_raw1" }`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      headers: { "content-type": "application/json", "x-boi-signature": sign(raw) },
      payload: raw,
    });

    expect(res.statusCode, res.body).toBe(204);
  }, 60_000);

  it("would fail if the parsed object were passed instead — the double proves it", () => {
    const c = verifyingChannel();
    const raw = '{"text":"2"}';
    // The shape the route must NOT use.
    expect(() => c.normalizeInbound(JSON.parse(raw), sign(raw))).toThrow(RawBodyRequiredError);
    // And the shape it does use.
    expect(() => c.normalizeInbound(raw, sign(raw))).not.toThrow();
  });

  it("rejects a body whose signature does not match, with 401 bad_signature", async () => {
    const raw = '{"text":"2"}';
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      headers: { "content-type": "application/json", "x-boi-signature": sign("something else") },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "bad_signature" });
  });

  it("rejects a body altered by even one byte", async () => {
    const raw = '{"text":"2"}';
    const signature = sign(raw);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      headers: { "content-type": "application/json", "x-boi-signature": signature },
      payload: '{"text":"1"}',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("the signature header is guarded, not assumed", () => {
  it("treats a missing header as 401, not as a TypeError", async () => {
    // `req.headers["x-boi-signature"]` is `string | string[] | undefined`. Undefined is
    // the common case — an unsigned probe — and it must be the documented 401 rather
    // than a 500 from calling a method on undefined.
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      headers: { "content-type": "application/json" },
      payload: '{"text":"2"}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "bad_signature" });
  });

  it("refuses a duplicated header rather than taking the first", () => {
    // Two headers is an attack shape, not a mistake: resolving it by taking [0] lets a
    // caller append a second value and have different layers disagree about which one
    // counted.
    expect(signatureHeader(["sha256=aaa", "sha256=bbb"])).toBeNull();
    expect(signatureHeader(undefined)).toBeNull();
    expect(signatureHeader("")).toBeNull();
    expect(signatureHeader("sha256=aaa")).toBe("sha256=aaa");
  });

  it("returns 401 for a duplicated header end to end", async () => {
    const raw = '{"text":"2"}';
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mock",
      headers: {
        "content-type": "application/json",
        "x-boi-signature": [sign(raw), sign(raw)] as unknown as string,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown provider before doing any work", async () => {
    const raw = '{"text":"2"}';
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/carrier-pigeon",
      headers: { "content-type": "application/json", "x-boi-signature": sign(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("the rest of the API still parses JSON normally", () => {
  it("the raw-body parser did not break a route that wants an object", async () => {
    // The parser replaces Fastify's default for the whole service, so this is the
    // regression it could have caused.
    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      payload: { schema_version: "digest.v1" },
    });
    // 401 because unauthenticated — the point is it parsed, rather than 500ing.
    expect(res.statusCode).toBe(401);
  });

  it("a malformed JSON body is a documented 400, not a 500", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    cleanup.push(scope);
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });

  it("still accepts the urlencoded signup form", async () => {
    const phone = nextPhone();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `phone_e164=${encodeURIComponent(phone)}&accept_terms=true`,
    });
    expect(res.statusCode).toBe(200);
    const { findUserIdByPhone } = await import("../../db/src/index.js");
    const scope = await findUserIdByPhone(phone);
    if (scope !== null) cleanup.push(scope);
  }, 60_000);
});
