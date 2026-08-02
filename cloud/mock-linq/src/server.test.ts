import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildServer,
  loadConfig,
  signBody,
  verifySignature,
  type MockLinqConfig,
  type MockLinqServer,
  type MockMode,
} from "./server.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const TRANSCRIPT_DIR = fileURLToPath(new URL("contracts/transcripts/linq/", REPO_ROOT));

function transcript(name: string): {
  request?: { body?: unknown };
  response?: { status?: number; body?: Record<string, unknown> };
  /** contracts/transcripts/linq/inbound_webhook.json records the body at the top level. */
  body?: unknown;
} {
  return JSON.parse(readFileSync(new URL(name, new URL("contracts/transcripts/linq/", REPO_ROOT)), "utf8"));
}

const SEND_TEXT_200 = transcript("send_text_200.json");
const SEND_LINE_BANNED_503 = transcript("send_line_banned_503.json");

const SECRET = "dev-secret-change-me";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

// CONTRACTS.md section 9 assigns Track C 3030-3039. Only the webhook receiver needs a
// real socket; every request against the mock itself goes through fastify's inject, so
// the suite binds exactly one port and never collides with a hand-run server on 3031.
const WEBHOOK_RECEIVER_PORT = 3033;

function testConfig(overrides: Partial<MockLinqConfig> = {}): MockLinqConfig {
  return {
    ...loadConfig({ MOCK_LINQ_LOG_LEVEL: "silent" } as NodeJS.ProcessEnv),
    transcriptDir: TRANSCRIPT_DIR,
    webhookSecret: SECRET,
    logLevel: "silent",
    ...overrides,
  };
}

async function withServer<T>(config: MockLinqConfig, fn: (s: MockLinqServer) => Promise<T>): Promise<T> {
  const server = buildServer(config);
  await server.app.ready();
  try {
    return await fn(server);
  } finally {
    await server.app.close();
  }
}

describe("mock linq — transcript conformance", () => {
  it("replays send_text_200 field for field", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(SEND_TEXT_200.response?.status);
      expect(res.json()).toEqual(SEND_TEXT_200.response?.body);
    });
  });

  it("serves both the transcript path and the OpenAPI localhost path", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      for (const url of ["/api/partner/v3/chats", "/chats"]) {
        const res = await s.app.inject({
          method: "POST",
          url,
          headers: AUTH,
          payload: JSON.stringify(SEND_TEXT_200.request?.body),
        });
        expect(res.statusCode, url).toBe(200);
      }
    });
  });

  it("synthesizes a spec-shaped response for a body no transcript recorded", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify({
          from: "+15550100123",
          to: ["+15559998888"],
          message: { parts: [{ type: "text", text: "unrecorded" }], protocol: "auto" },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.id).toMatch(/^lmsg_/);
      expect(body.status).toBe("queued");
      expect(body.protocol).toBe("imessage");
      expect(body.trace_id).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });
  });
});

describe("mock linq — auth", () => {
  it("rejects a request with no bearer token", async () => {
    await withServer(testConfig(), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    });
  });

  it("rejects an empty or malformed bearer token, and guards the read endpoints too", async () => {
    await withServer(testConfig(), async (s) => {
      for (const authorization of ["Bearer ", "token abc", ""]) {
        const res = await s.app.inject({
          method: "POST",
          url: "/api/partner/v3/chats",
          headers: { authorization, "content-type": "application/json" },
          payload: JSON.stringify(SEND_TEXT_200.request?.body),
        });
        expect(res.statusCode, authorization).toBe(401);
      }
      expect((await s.app.inject({ method: "GET", url: "/api/partner/v3/lines" })).statusCode).toBe(401);
      expect((await s.app.inject({ method: "GET", url: "/api/partner/v3/chats/lmsg_01J8ZK" })).statusCode).toBe(401);
    });
  });

  it("requires an exact token when one is configured", async () => {
    await withServer(testConfig({ expectedToken: "the-real-one" }), async (s) => {
      const send = (authorization: string) =>
        s.app.inject({
          method: "POST",
          url: "/api/partner/v3/chats",
          headers: { authorization, "content-type": "application/json" },
          payload: JSON.stringify(SEND_TEXT_200.request?.body),
        });
      expect((await send("Bearer wrong")).statusCode).toBe(401);
      expect((await send("Bearer the-real-one")).statusCode).toBe(200);
    });
  });
});

describe("mock linq — fault injection", () => {
  it("banned returns the recorded 503 transcript body", async () => {
    await withServer(testConfig({ mode: "banned" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(SEND_LINE_BANNED_503.response?.status);
      expect(res.json()).toEqual(SEND_LINE_BANNED_503.response?.body);
    });
  });

  it("ratelimited returns 429 with Retry-After", async () => {
    await withServer(testConfig({ mode: "ratelimited", retryAfterSeconds: 42 }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBe("42");
    });
  });

  it("degraded returns 200 with protocol sms", async () => {
    await withServer(testConfig({ mode: "degraded" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Record<string, unknown>).protocol).toBe("sms");
    });
  });

  it("MOCK_LINQ_MODE selects the mode from the environment, and rejects an unknown one", () => {
    for (const mode of ["up", "degraded", "banned", "ratelimited"] satisfies MockMode[]) {
      expect(loadConfig({ MOCK_LINQ_MODE: mode } as NodeJS.ProcessEnv).mode).toBe(mode);
    }
    expect(() => loadConfig({ MOCK_LINQ_MODE: "on_fire" } as NodeJS.ProcessEnv)).toThrow(/invalid MOCK_LINQ_MODE/);
  });

  it("defaults to port 3031 and mode up", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.port).toBe(3031);
    expect(config.mode).toBe("up");
  });
});

describe("mock linq — read endpoints", () => {
  it("GET /chats/{id} returns the status of a sent message and 404 for an unknown id", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const sent = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      const id = String((sent.json() as Record<string, unknown>).id);

      const res = await s.app.inject({ method: "GET", url: `/api/partner/v3/chats/${id}`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, status: "queued", protocol: "imessage" });

      const missing = await s.app.inject({ method: "GET", url: "/api/partner/v3/chats/lmsg_nope", headers: AUTH });
      expect(missing.statusCode).toBe(404);
    });
  });

  it("GET /lines reports the guessed health shape, tracking the injected mode", async () => {
    const expected: [MockMode, string][] = [
      ["up", "up"],
      ["degraded", "degraded"],
      ["banned", "banned"],
    ];
    for (const [mode, status] of expected) {
      await withServer(testConfig({ mode }), async (s) => {
        const res = await s.app.inject({ method: "GET", url: "/api/partner/v3/lines", headers: AUTH });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ lines: [{ id: "line_a1", handle: "+15550100123", status }] });
      });
    }
  });
});

describe("mock linq — validation", () => {
  it("rejects a body missing the required fields", async () => {
    await withServer(testConfig(), async (s) => {
      const bad: unknown[] = [
        {},
        { from: "+15550100123", to: [], message: { parts: [{ type: "text", text: "x" }] } },
        { from: "+15550100123", to: ["+1555"], message: { parts: [] } },
        { from: "+15550100123", to: ["+1555"], message: { parts: [{ type: "text" }] } },
        { from: "+15550100123", to: ["+1555"], message: { parts: [{ type: "sticker" }] } },
      ];
      for (const payload of bad) {
        const res = await s.app.inject({
          method: "POST",
          url: "/api/partner/v3/chats",
          headers: AUTH,
          payload: JSON.stringify(payload),
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect((res.json() as Record<string, unknown>).error).toBe("validation");
      }
    });
  });

  it("refuses a multi-recipient send — group chats are out of MVP scope on consent grounds", async () => {
    await withServer(testConfig(), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify({
          from: "+15550100123",
          to: ["+15551234567", "+15559998888"],
          message: { parts: [{ type: "text", text: "hi" }], protocol: "auto" },
        }),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("mock linq — request recorder", () => {
  it("records the exact payload sent, so message.parts can be asserted", async () => {
    await withServer(testConfig(), async (s) => {
      await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });

      const last = s.recorder.last();
      expect(last).not.toBeNull();
      expect(last?.method).toBe("POST");
      expect(last?.path).toBe("/api/partner/v3/chats");
      expect(last?.headers.authorization).toBe("Bearer test-token");
      expect(last?.body).toEqual(SEND_TEXT_200.request?.body);
      expect(last?.raw_body).toBe(JSON.stringify(SEND_TEXT_200.request?.body));
      expect(last?.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

      const parts = (last?.body as { message: { parts: { type: string; text: string }[] } }).message.parts;
      expect(parts).toEqual([{ type: "text", text: "3 people are waiting on you." }]);
    });
  });

  it("exposes and clears the record over the control plane, and does not record itself", async () => {
    await withServer(testConfig(), async (s) => {
      await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      const listed = await s.app.inject({ method: "GET", url: "/__mock/requests" });
      expect((listed.json() as { requests: unknown[] }).requests).toHaveLength(1);

      expect((await s.app.inject({ method: "DELETE", url: "/__mock/requests" })).statusCode).toBe(204);
      const after = await s.app.inject({ method: "GET", url: "/__mock/requests" });
      expect((after.json() as { requests: unknown[] }).requests).toHaveLength(0);
    });
  });

  it("records a rejected request too — a 401 still tells you what the client sent", async () => {
    await withServer(testConfig(), async (s) => {
      await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(s.recorder.all()).toHaveLength(1);
    });
  });
});

describe("mock linq — webhook signing", () => {
  let receiver: Server;
  const received: { raw: string; signature: string | undefined }[] = [];

  beforeAll(async () => {
    receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const header = req.headers["x-boi-signature"];
        received.push({
          raw: Buffer.concat(chunks).toString("utf8"),
          signature: typeof header === "string" ? header : undefined,
        });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((done) => receiver.listen(WEBHOOK_RECEIVER_PORT, "127.0.0.1", done));
  });

  afterAll(async () => {
    await new Promise<void>((done, fail) => receiver.close((err) => (err ? fail(err) : done())));
  });

  beforeEach(() => {
    received.length = 0;
  });

  const receiverUrl = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}/webhook`;

  it("signs the delivered body sha256=<hex> and a test can recompute it", async () => {
    await withServer(testConfig({ webhookUrl: receiverUrl }), async (s) => {
      const raw = JSON.stringify(transcript("inbound_webhook.json").body ?? {});
      const result = await s.deliverWebhook(raw);

      expect(result.status).toBe(204);
      expect(received).toHaveLength(1);

      const expected = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
      expect(result.signature).toBe(expected);
      expect(received[0]?.signature).toBe(expected);
      expect(received[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(received[0]?.raw).toBe(raw);
    });
  });

  it("signs the RAW body, not a re-serialization — unusual key ordering still verifies", async () => {
    // If anything in the path parsed and re-serialized the JSON, key order would
    // normalize and this signature would not match. That bug passes every test that
    // signs an object instead of bytes, and then fails on the first live webhook.
    const oddOrdering = '{"zzz_last":1,"reply_to":"lmsg_01J8ZK","id":"lmsg_01J8ZM",  "aaa_first":  2}';
    const canonical = JSON.stringify(JSON.parse(oddOrdering));
    expect(canonical).not.toBe(oddOrdering);

    await withServer(testConfig({ webhookUrl: receiverUrl }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/__mock/webhooks/deliver",
        headers: { "content-type": "application/json" },
        payload: oddOrdering,
      });
      expect(res.statusCode).toBe(200);

      expect(received).toHaveLength(1);
      const delivered = received[0];
      expect(delivered?.raw).toBe(oddOrdering);

      const overRaw = `sha256=${createHmac("sha256", SECRET).update(oddOrdering).digest("hex")}`;
      const overCanonical = `sha256=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`;
      expect(overRaw).not.toBe(overCanonical);
      expect(delivered?.signature).toBe(overRaw);
      expect(verifySignature(oddOrdering, delivered?.signature, SECRET)).toBe(true);
      expect(verifySignature(canonical, delivered?.signature, SECRET)).toBe(false);
    });
  });

  it("delivers to a per-request url override", async () => {
    await withServer(testConfig({ webhookUrl: null }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: `/__mock/webhooks/deliver?url=${encodeURIComponent(receiverUrl)}`,
        headers: { "content-type": "application/json" },
        payload: '{"id":"lmsg_x"}',
      });
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(1);
    });
  });

  it("reports rather than guesses when no webhook url is configured", async () => {
    await withServer(testConfig({ webhookUrl: null }), async (s) => {
      await expect(s.deliverWebhook('{"id":"x"}')).rejects.toThrow(/no webhook url configured/);
    });
  });
});

describe("mock linq — signature helpers", () => {
  it("verifySignature rejects a wrong secret, a wrong body, and a missing header", () => {
    const raw = '{"a":1}';
    const sig = signBody(raw, SECRET);
    expect(verifySignature(raw, sig, SECRET)).toBe(true);
    expect(verifySignature(raw, sig, "other-secret")).toBe(false);
    expect(verifySignature('{"a":2}', sig, SECRET)).toBe(false);
    expect(verifySignature(raw, undefined, SECRET)).toBe(false);
    expect(verifySignature(raw, "sha256=short", SECRET)).toBe(false);
  });
});
