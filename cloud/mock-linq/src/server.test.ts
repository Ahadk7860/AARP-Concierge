import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildServer,
  loadConfig,
  signBody,
  verifySignature,
  DEV_TOKEN,
  type MockLinqConfig,
  type MockLinqServer,
  type MockMode,
} from "./server.js";

const REPO_ROOT = new URL("../../../", import.meta.url);

// The transcripts and the OpenAPI document are EXPECTED VALUES here, and nothing under
// cloud/mock-linq/ reads them at runtime. That asymmetry is the point: if the server
// served a transcript and the test asserted against the same transcript, the assertion
// would be file === file through fastify and could not fail.
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

// ---- contracts/openapi/linq-v3-subset.yaml, read as the arbiter of response shape ----

type SchemaNode = {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  enum?: string[];
};

const OPENAPI = parseYaml(
  readFileSync(new URL("contracts/openapi/linq-v3-subset.yaml", REPO_ROOT), "utf8"),
) as {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: SchemaNode }> }> }>>;
};

function responseSchema(path: string, method: string, status: string): SchemaNode {
  const schema = OPENAPI.paths[path]?.[method]?.responses[status]?.["content"]?.["application/json"]?.schema;
  if (schema === undefined) throw new Error(`no schema in the spec for ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

/** Assert a response body against the spec: required keys present, NO extra keys, and
 *  every enum-constrained value inside its enum. */
function expectMatchesSchema(body: unknown, schema: SchemaNode, where: string): void {
  expect(typeof body, `${where}: body must be an object`).toBe("object");
  expect(body, `${where}: body must not be null`).not.toBeNull();
  const obj = body as Record<string, unknown>;
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    expect(Object.keys(obj), `${where}: required key '${key}' missing`).toContain(key);
  }
  for (const key of Object.keys(obj)) {
    expect(Object.keys(properties), `${where}: '${key}' is not in the spec`).toContain(key);
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = properties[key];
    if (prop === undefined) continue;
    if (prop.type === "string") expect(typeof value, `${where}: '${key}' must be a string`).toBe("string");
    if (prop.enum !== undefined) expect(prop.enum, `${where}: '${key}' outside its enum`).toContain(value);
  }
}

const SECRET = "dev-secret-change-me";
const AUTH = { authorization: `Bearer ${DEV_TOKEN}`, "content-type": "application/json" };

// CONTRACTS.md section 9 assigns Track C 3030-3039. Only the webhook receiver needs a
// real socket; every request against the mock itself goes through fastify's inject, so
// the suite binds exactly one port and never collides with a hand-run server on 3031.
const WEBHOOK_RECEIVER_PORT = 3033;

function testConfig(overrides: Partial<MockLinqConfig> = {}): MockLinqConfig {
  return {
    ...loadConfig({ MOCK_LINQ_LOG_LEVEL: "silent" } as NodeJS.ProcessEnv),
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

describe("mock linq — conformance with contracts/openapi/linq-v3-subset.yaml", () => {
  it("answers the transcript's request with a response the SPEC accepts", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });

      expect(res.statusCode).toBe(SEND_TEXT_200.response?.status);
      // Asserted against the OpenAPI document, not against the transcript's recorded
      // response body. The transcript supplies the REQUEST; the spec judges the reply.
      expectMatchesSchema(res.json(), responseSchema("/chats", "post", "200"), "POST /chats 200");

      // And the spec's own enums, spelled out so a spec edit that widened them without
      // the mock noticing would still be caught here.
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe("queued");
      expect(body.protocol).toBe("imessage");
      expect(body.trace_id).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(String(body.id)).toMatch(/^lmsg_/);
    });
  });

  it("rejects a response carrying a key the spec does not define", () => {
    // Proves the conformance assertion above can actually fail. Without this, a broken
    // expectMatchesSchema would make every conformance test vacuously green.
    const schema = responseSchema("/chats", "post", "200");
    expect(() =>
      expectMatchesSchema({ id: "lmsg_1", status: "queued", protocol: "sms", surprise: 1 }, schema, "negative"),
    ).toThrow();
    expect(() => expectMatchesSchema({ id: "lmsg_1", status: "queued" }, schema, "negative")).toThrow();
    expect(() =>
      expectMatchesSchema({ id: "lmsg_1", status: "teleported", protocol: "sms" }, schema, "negative"),
    ).toThrow();
  });

  it("serves the canonical prefix and ONLY the canonical prefix", async () => {
    // CONTRACTS.md section 11 item 1b, resolved: LINQ_BASE_URL includes /api/partner/v3.
    // A mock that also answered bare /chats would let an adapter built against the wrong
    // base pass every test here and 404 on the first live send.
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const payload = JSON.stringify(SEND_TEXT_200.request?.body);
      const canonical = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload,
      });
      expect(canonical.statusCode).toBe(200);

      for (const url of ["/chats", "/v3/chats", "/partner/v3/chats"]) {
        const res = await s.app.inject({ method: "POST", url, headers: AUTH, payload });
        expect(res.statusCode, `${url} must 404 exactly as production would`).toBe(404);
      }
      expect((await s.app.inject({ method: "GET", url: "/lines", headers: AUTH })).statusCode).toBe(404);
    });
  });

  it("issues a UNIQUE id for every send", async () => {
    // A mock that replayed the transcript's recorded id would hand out one immutable
    // lmsg_01J8ZK forever, and prompt 02's idempotency test would pass against a server
    // that cannot tell two sends apart.
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const payload = JSON.stringify(SEND_TEXT_200.request?.body);
      const ids: string[] = [];
      const traceIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await s.app.inject({ method: "POST", url: "/api/partner/v3/chats", headers: AUTH, payload });
        const body = res.json() as Record<string, unknown>;
        ids.push(String(body.id));
        traceIds.push(String(body.trace_id));
      }
      expect(new Set(ids).size, `ids repeated: ${ids.join(", ")}`).toBe(5);
      expect(new Set(traceIds).size).toBe(5);
      expect(ids).not.toContain(String(SEND_TEXT_200.response?.body?.id));
    });
  });

  it("GET /chats/{id} and GET /lines conform to the spec's response schemas", async () => {
    await withServer(testConfig({ mode: "up" }), async (s) => {
      const sent = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      const id = String((sent.json() as Record<string, unknown>).id);

      const status = await s.app.inject({ method: "GET", url: `/api/partner/v3/chats/${id}`, headers: AUTH });
      expectMatchesSchema(status.json(), responseSchema("/chats/{id}", "get", "200"), "GET /chats/{id} 200");

      const lines = await s.app.inject({ method: "GET", url: "/api/partner/v3/lines", headers: AUTH });
      const body = lines.json() as { lines: unknown[] };
      expect(Object.keys(body)).toEqual(["lines"]);
      const lineSchema = { properties: { id: {}, handle: {}, status: { enum: ["up", "degraded", "banned"] } } };
      for (const line of body.lines) {
        expectMatchesSchema(line, lineSchema as SchemaNode, "GET /lines 200 line");
      }
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

  it("requires the token EXACTLY — a wrong non-empty bearer is a 401, not a pass", async () => {
    // The default must not be "accept anything". A mock that takes any non-empty bearer
    // lets an adapter ship without ever reading LINQ_API_TOKEN and stay green until the
    // first live send.
    await withServer(testConfig({ expectedToken: "the-real-one" }), async (s) => {
      const send = (authorization: string) =>
        s.app.inject({
          method: "POST",
          url: "/api/partner/v3/chats",
          headers: { authorization, "content-type": "application/json" },
          payload: JSON.stringify(SEND_TEXT_200.request?.body),
        });
      expect((await send("Bearer wrong")).statusCode).toBe(401);
      expect((await send(`Bearer ${DEV_TOKEN}`)).statusCode).toBe(401);
      expect((await send("Bearer the-real-one")).statusCode).toBe(200);
    });
  });

  it("defaults to requiring DEV_TOKEN, not to accepting any bearer", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).expectedToken).toBe(DEV_TOKEN);
    // .env.example ships LINQ_API_TOKEN= empty; empty must mean "unset", never "any".
    expect(loadConfig({ LINQ_API_TOKEN: "" } as NodeJS.ProcessEnv).expectedToken).toBe(DEV_TOKEN);
    expect(loadConfig({ LINQ_API_TOKEN: "rep-issued" } as NodeJS.ProcessEnv).expectedToken).toBe("rep-issued");
  });

  it("rejects an arbitrary bearer under the default config", async () => {
    await withServer(testConfig(), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: { authorization: "Bearer anything-at-all", "content-type": "application/json" },
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it("accepts any non-empty bearer only when explicitly opted in", async () => {
    await withServer(testConfig({ expectedToken: "" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: { authorization: "Bearer whatever", "content-type": "application/json" },
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe("mock linq — fault injection", () => {
  it("banned matches the recorded 503 transcript, which the server does not read", async () => {
    // Non-circular: the server writes this body out itself and the transcript is the
    // independent expected value. line_a1 is the mock's default line id and is also what
    // the transcript records.
    await withServer(testConfig({ mode: "banned" }), async (s) => {
      const res = await s.app.inject({
        method: "POST",
        url: "/api/partner/v3/chats",
        headers: AUTH,
        payload: JSON.stringify(SEND_TEXT_200.request?.body),
      });
      expect(res.statusCode).toBe(SEND_LINE_BANNED_503.response?.status);
      expect(res.json()).toEqual(SEND_LINE_BANNED_503.response?.body);
      expectMatchesSchema(res.json(), responseSchema("/chats", "post", "503"), "POST /chats 503");
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

  it("accepts a multi-recipient send — the spec sets minItems 1 and no maximum", async () => {
    // Group chats are out of MVP scope on consent grounds, but that is a product
    // constraint the composer enforces, not a property of this wire format. A mock
    // stricter than the spec rejects requests the real API would accept, which is the
    // same class of lie as a mock that is laxer than it.
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
      expect(res.statusCode).toBe(200);
      expectMatchesSchema(res.json(), responseSchema("/chats", "post", "200"), "multi-recipient 200");
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
      expect(last?.headers.authorization).toBe(`Bearer ${DEV_TOKEN}`);
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
