// POST /v1/webhooks/{provider} — the two things Track C said would bite.
//
// Track D owns what happens to a normalized message; Track C owns getting there. These
// tests are about the handoff, which is where both reported gaps live: the raw bytes,
// and a header type Fastify makes wider than it looks.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { StubChannel } from "../../shared/src/index.js";
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
 * A stand-in for Track C's adapter: verify an HMAC over the RAW BYTES, then parse.
 *
 * `StubChannel` now enforces the same rule — `normalizeInbound` was retyped from
 * `unknown` to `Buffer | string` on 2 Aug and throws `raw_body_required` on a parsed
 * object — and the bottom of this file drives the route through it. This double is
 * still worth having because the stub accepts any body with a fixed signature string,
 * so it cannot show that the bytes reached the verifier UNCHANGED. Only a real HMAC
 * over awkward whitespace and key order can do that.
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
    normalizeInbound(rawBody: Buffer | string, signature: string): InboundMessage {
      // THE ASSERTION THAT MATTERS. A parsed object cannot be verified: re-serialising
      // it moves key order and whitespace, so the digest never matches what was signed.
      // Now a compile-time error too, but kept at run time — a cast would slip past the
      // type and this is the check that would still catch it.
      if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) {
        throw new RawBodyRequiredError();
      }
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;

      const expected = `sha256=${createHmac("sha256", SECRET).update(text, "utf8").digest("hex")}`;
      if (signature !== expected) throw new Error("bad_signature");

      const body = JSON.parse(text) as Record<string, unknown>;
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
    // The shape the route must NOT use. A cast, because the retyped interface now
    // rejects it at compile time — which is the point.
    expect(() =>
      c.normalizeInbound(JSON.parse(raw) as unknown as string, sign(raw)),
    ).toThrow(RawBodyRequiredError);
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

// ---------------------------------------------------------------------------

/**
 * The foundation's stub, driven end to end.
 *
 * `Channel.normalizeInbound` was retyped from `unknown` to `Buffer | string` on 2 Aug,
 * and `StubChannel` now enforces it — it throws `raw_body_required` on a parsed object
 * and parses real bytes otherwise. That closes the gap this track reported: before, the
 * stub and Track C's adapter disagreed about what the first argument MEANT, so a route
 * developed against the stub broke on the first live webhook.
 *
 * These tests exist because the local double above proves my route is correct against
 * my own idea of the contract. Only the stub proves it against the foundation's.
 */
describe("the raw-body path against StubChannel", () => {
  const raw = JSON.stringify({ id: "mmsg_stub_7", from: "+15551234567", text: "2" });

  it("parses an actual Buffer", () => {
    const stub = new StubChannel();
    const inbound = stub.normalizeInbound(Buffer.from(raw, "utf8"), "stub-signature");
    expect(inbound.schema_version).toBe("inbound.v1");
    expect(inbound.provider_message_id).toBe("mmsg_stub_7");
    expect(inbound.text).toBe("2");
    expect(inbound.from_handle).toBe("+15551234567");
  });

  it("parses a raw string identically to the same bytes as a Buffer", () => {
    const stub = new StubChannel();
    const fromString = stub.normalizeInbound(raw, "stub-signature");
    const fromBuffer = stub.normalizeInbound(Buffer.from(raw, "utf8"), "stub-signature");
    // `received_at` is generated per call, so compare everything else.
    const strip = (m: InboundMessage): Omit<InboundMessage, "received_at"> => {
      const { received_at: _ignored, ...rest } = m;
      return rest;
    };
    expect(strip(fromBuffer)).toEqual(strip(fromString));
  });

  it("throws raw_body_required on a parsed object — the gap, now closed", () => {
    const stub = new StubChannel();
    // The exact mistake the old `unknown` signature allowed. It is now a type error at
    // compile time AND a throw at run time, so neither a new route nor a cast can
    // reintroduce it quietly.
    expect(() =>
      stub.normalizeInbound(JSON.parse(raw) as unknown as string, "stub-signature"),
    ).toThrow(/raw_body_required/);
  });

  it("rejects a bad signature before it looks at the body at all", () => {
    const stub = new StubChannel();
    // Garbage bytes with a wrong signature must fail on the signature, not on the JSON —
    // verify-then-parse, so a malformed body from an unauthenticated caller never
    // reaches a parser.
    expect(() => stub.normalizeInbound(Buffer.from("{not json", "utf8"), "wrong")).toThrow(
      /bad_signature/,
    );
  });

  it("drives the real route with StubChannel and a real Buffer body", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    cleanup.push(scope);

    const stubApp = buildServer({
      channel: new StubChannel(),
      logger: makeLogger(new PassThrough()),
    });
    await stubApp.ready();
    try {
      const res = await stubApp.inject({
        method: "POST",
        url: "/v1/webhooks/mock",
        headers: { "content-type": "application/json", "x-boi-signature": "stub-signature" },
        payload: Buffer.from(raw, "utf8"),
      });
      // 204 means the raw bytes reached `normalizeInbound` intact. If the route had
      // handed over a parsed object the stub would have thrown and this would be 401.
      expect(res.statusCode, res.body).toBe(204);

      // And a wrong signature is the documented 401 through the same path.
      const bad = await stubApp.inject({
        method: "POST",
        url: "/v1/webhooks/mock",
        headers: { "content-type": "application/json", "x-boi-signature": "nope" },
        payload: Buffer.from(raw, "utf8"),
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: "bad_signature" });
    } finally {
      await stubApp.close();
    }
  }, 60_000);

  it("handles the stub's null user_id by resolving the sender's own handle", async () => {
    // StubChannel always returns `user_id: null` and a fixed `from_handle`. That is the
    // path a real transport takes when it does not know the account yet, so it is worth
    // exercising: the resolver falls back to the account holder's own number.
    const phone = "+15551234567"; // the stub's from_handle
    const existing = await (await import("../../db/src/index.js")).findUserIdByPhone(phone);
    if (existing !== null) await deleteUser(existing);

    const { scope } = await createUser({ phone_e164: phone });
    cleanup.push(scope);

    const stub = new StubChannel();
    const inbound = stub.normalizeInbound(Buffer.from(raw, "utf8"), "stub-signature");
    expect(inbound.user_id).toBeNull();

    const { resolveUser } = await import("../../brief/src/inbound.js");
    expect((await resolveUser(inbound))?.user_id).toBe(scope.user_id);
  }, 60_000);
});
