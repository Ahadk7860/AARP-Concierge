// Mock Linq Partner API v3 — Track C.
//
// This is NOT a convenience fixture. It is a written-down hypothesis about a wire
// format that has never responded to us, and its job is to be DIFFABLE. It implements
// contracts/openapi/linq-v3-subset.yaml and replays contracts/transcripts/linq/*.json
// literally, including the places we suspect the real API differs. A mock that quietly
// "improves" on the spec hides the discrepancy it exists to surface.
//
// Every answer to CONTRACTS.md section 11 items 4-7 (SLA coverage, line stickiness,
// rotation notice, tenants per line) lands in `MockLinqConfig`, never in a branch.
//
// Run:  node cloud/mock-linq/src/server.ts
//
// Deliberately self-contained: Node's type stripping does not resolve `./x.js` to
// `x.ts`, so an entry module that must run under plain `node` cannot carry relative
// imports. Everything the server needs lives in this file.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { request as undiciRequest } from "undici";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// Config — the only place a sales-call answer is allowed to land
// ---------------------------------------------------------------------------

/** Fault injection. `MOCK_LINQ_MODE` selects one; these are what make the adapter's
 *  error paths testable without a token. */
export type MockMode = "up" | "degraded" | "banned" | "ratelimited";

export const MOCK_MODES: readonly MockMode[] = ["up", "degraded", "banned", "ratelimited"];

export type MockLinqConfig = {
  port: number;
  host: string;
  mode: MockMode;
  /** CONTRACTS.md section 11 item 7 — tenants per line is unknown; the line identity
   *  the mock reports is config, so a dedicated-line answer changes no code. */
  lineId: string;
  fromHandle: string;
  webhookSecret: string;
  /** Where outbound webhooks are delivered. Null means "nowhere configured yet". */
  webhookUrl: string | null;
  /** Null accepts any non-empty bearer token, which is the only thing we can do
   *  before a rep provisions one. Set it to require an exact match. */
  expectedToken: string | null;
  /** CONTRACTS.md section 11 item 3 — real limits unknown; this is the 429 hint. */
  retryAfterSeconds: number;
  /** The OpenAPI document lists the mock server as `http://localhost:3031` with paths
   *  like `/chats`, while contracts/transcripts/linq/*.json record the path as
   *  `/api/partner/v3/chats`. Both readings are served; see NOTES.md. */
  pathPrefixes: string[];
  transcriptDir: string;
  logLevel: string;
};

const REPO_ROOT = new URL("../../../", import.meta.url);

function parseMode(raw: string | undefined): MockMode {
  if (raw === undefined || raw === "") return "up";
  const found = MOCK_MODES.find((m) => m === raw);
  if (found === undefined) {
    throw new Error(`invalid MOCK_LINQ_MODE: ${raw} (expected one of ${MOCK_MODES.join(", ")})`);
  }
  return found;
}

function parseInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${label}: ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockLinqConfig {
  return {
    // CONTRACTS.md section 9 assigns Track C 3030-3039; mock Linq is 3031.
    port: parseInteger(env.MOCK_LINQ_PORT, 3031, "MOCK_LINQ_PORT"),
    host: env.MOCK_LINQ_HOST ?? "127.0.0.1",
    mode: parseMode(env.MOCK_LINQ_MODE),
    lineId: env.MOCK_LINQ_LINE_ID ?? "line_a1",
    fromHandle: env.LINQ_FROM_HANDLE ?? "+15550100123",
    webhookSecret: env.LINQ_WEBHOOK_SECRET ?? "dev-secret-change-me",
    webhookUrl: env.MOCK_LINQ_WEBHOOK_URL ?? null,
    expectedToken: env.MOCK_LINQ_EXPECTED_TOKEN ?? null,
    retryAfterSeconds: parseInteger(env.MOCK_LINQ_RETRY_AFTER, 30, "MOCK_LINQ_RETRY_AFTER"),
    pathPrefixes: (env.MOCK_LINQ_PATH_PREFIXES ?? "/api/partner/v3,").split(","),
    transcriptDir:
      env.MOCK_LINQ_TRANSCRIPT_DIR ?? fileURLToPath(new URL("contracts/transcripts/linq/", REPO_ROOT)),
    logLevel: env.MOCK_LINQ_LOG_LEVEL ?? "info",
  };
}

// ---------------------------------------------------------------------------
// Signing — HMAC-SHA256 over the RAW body, hex, `sha256=` prefixed
// ---------------------------------------------------------------------------
//
// CONTRACTS.md section 11 item 2: this scheme is a placeholder and is UNVERIFIED.
// Signing the re-serialized object instead of the bytes on the wire is the classic
// way to ship a signature check that passes in tests and fails in production, so the
// raw buffer is threaded end to end and never round-tripped through JSON.

export const SIGNATURE_HEADER = "x-boi-signature";

export function signBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(signBody(rawBody, secret));
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Request recorder
// ---------------------------------------------------------------------------

/** Wire shape, so CONTRACTS.md section 6 applies: snake_case keys. */
export type RecordedRequest = {
  seq: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  raw_body: string | null;
  body: unknown;
  received_at: string;
};

export class RequestRecorder {
  private entries: RecordedRequest[] = [];
  private seq = 0;

  record(entry: Omit<RecordedRequest, "seq">): RecordedRequest {
    this.seq += 1;
    const recorded: RecordedRequest = { seq: this.seq, ...entry };
    this.entries.push(recorded);
    return recorded;
  }

  all(): RecordedRequest[] {
    return this.entries.slice();
  }

  last(): RecordedRequest | null {
    return this.entries.length === 0 ? null : (this.entries[this.entries.length - 1] as RecordedRequest);
  }

  clear(): void {
    this.entries = [];
    this.seq = 0;
  }
}

// ---------------------------------------------------------------------------
// Transcripts — the mock IS the transcript, so the diff on day one is honest
// ---------------------------------------------------------------------------

type Transcript = {
  request?: { method?: string; path?: string; body?: unknown };
  response?: { status?: number; body?: unknown };
};

export type LoadedTranscripts = {
  /** Recorded request body -> recorded response, replayed verbatim on an exact match. */
  sends: { requestBody: unknown; status: number; body: unknown }[];
  /** The recorded 503 body, used verbatim by `banned` mode. */
  lineBanned: { status: number; body: unknown };
};

function readTranscript(dir: string, name: string): Transcript {
  const url = new URL(name, pathToFileURL(`${resolvePath(dir)}/`));
  return JSON.parse(readFileSync(url, "utf8")) as Transcript;
}

export function loadTranscripts(dir: string): LoadedTranscripts {
  const sendText = readTranscript(dir, "send_text_200.json");
  const banned = readTranscript(dir, "send_line_banned_503.json");
  return {
    sends: [
      {
        requestBody: sendText.request?.body,
        status: sendText.response?.status ?? 200,
        body: sendText.response?.body,
      },
    ],
    lineBanned: {
      status: banned.response?.status ?? 503,
      body: banned.response?.body,
    },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

// ---------------------------------------------------------------------------
// Wire types from contracts/openapi/linq-v3-subset.yaml
// ---------------------------------------------------------------------------

export type LinqProtocol = "imessage" | "rcs" | "sms";

type SendRequestBody = {
  from?: unknown;
  to?: unknown;
  message?: { parts?: unknown; reply_to?: unknown; protocol?: unknown };
};

type SendRecord = {
  id: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  protocol: LinqProtocol;
  trace_id: string;
};

/** A W3C traceparent, derived from the message id so a replayed test is stable. */
function traceparentFor(id: string): string {
  const h = createHash("sha256").update(id).digest("hex");
  return `00-${h.slice(0, 32)}-${h.slice(32, 48)}-01`;
}

function validateSendBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be an object";
  const b = body as SendRequestBody;
  if (typeof b.from !== "string" || b.from === "") return "from is required";
  if (!Array.isArray(b.to) || b.to.length < 1) return "to must be a non-empty array";
  if (!b.to.every((t) => typeof t === "string" && t !== "")) return "to entries must be strings";
  if (typeof b.message !== "object" || b.message === null) return "message is required";
  const parts = b.message.parts;
  if (!Array.isArray(parts) || parts.length < 1) return "message.parts must be a non-empty array";
  for (const part of parts) {
    if (typeof part !== "object" || part === null) return "message.parts entries must be objects";
    const p = part as Record<string, unknown>;
    if (p.type === "text") {
      if (typeof p.text !== "string") return "text part requires text";
    } else if (p.type === "media") {
      if (typeof p.url !== "string") return "media part requires url";
    } else if (p.type === "contact_card") {
      if (typeof p.contact !== "object" || p.contact === null) return "contact_card part requires contact";
    } else {
      return `unknown part type: ${String(p.type)}`;
    }
  }
  // Group chats exist in the API and are deliberately out of MVP scope on consent
  // grounds, so the mock does not pretend to support fan-out.
  if (Array.isArray(b.to) && b.to.length > 1) return "group send is out of scope";
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export type MockLinqServer = {
  app: FastifyInstance;
  config: MockLinqConfig;
  recorder: RequestRecorder;
  /** Sends a webhook to `url` (or the configured one) with the RAW bytes given,
   *  signed `sha256=<hex>`. The bytes are never re-serialized. */
  deliverWebhook(rawBody: string | Buffer, url?: string): Promise<{ status: number; signature: string; url: string }>;
};

type RawRequest = FastifyRequest & { rawBody?: string };

function headersOf(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(", ");
  }
  return out;
}

/** The spec documents no error body for 401. CONTRACTS.md section 6 says error bodies
 *  are `{ "error": "<slug>" }`, so that is what the mock emits; recorded in NOTES.md
 *  as a place the real API may differ. */
function authorized(req: FastifyRequest, config: MockLinqConfig): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return false;
  if (config.expectedToken !== null) return token === config.expectedToken;
  return true;
}

export function buildServer(config: MockLinqConfig = loadConfig()): MockLinqServer {
  const recorder = new RequestRecorder();
  const transcripts = loadTranscripts(config.transcriptDir);
  const sends = new Map<string, SendRecord>();
  let counter = 0;

  const app = Fastify({ logger: { level: config.logLevel } });

  // Keep the raw bytes. Everything downstream that signs or records must see exactly
  // what arrived, not a re-serialization of the parsed object.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as RawRequest).rawBody = body as string;
    if (body === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string) as unknown);
    } catch {
      // Spec-silent. Hand the route an undefined body and let validation answer.
      done(null, undefined);
    }
  });

  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/__mock/")) return;
    recorder.record({
      method: req.method,
      path: req.url,
      headers: headersOf(req),
      raw_body: (req as RawRequest).rawBody ?? null,
      body: req.body ?? null,
      received_at: new Date().toISOString(),
    });
  });

  function postChats(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    if (!authorized(req, config)) return reply.code(401).send({ error: "unauthorized" });

    if (config.mode === "banned") {
      return reply.code(transcripts.lineBanned.status).send(transcripts.lineBanned.body);
    }
    if (config.mode === "ratelimited") {
      return reply
        .code(429)
        .header("Retry-After", String(config.retryAfterSeconds))
        .send({ error: "rate_limited" });
    }

    const invalid = validateSendBody(req.body);
    if (invalid !== null) return reply.code(400).send({ error: "validation", detail: invalid });

    const protocol: LinqProtocol = config.mode === "degraded" ? "sms" : "imessage";

    // Replay a recorded transcript verbatim when the request matches one, so a test
    // asserting transcript conformance is asserting against the transcript itself.
    const match = transcripts.sends.find((t) => deepEqual(t.requestBody, req.body));
    if (match !== undefined) {
      const body: Record<string, unknown> = { ...(match.body as Record<string, unknown>), protocol };
      const record: SendRecord = {
        id: String(body.id),
        status: body.status as SendRecord["status"],
        protocol,
        trace_id: String(body.trace_id),
      };
      sends.set(record.id, record);
      return reply.code(match.status).send(body);
    }

    counter += 1;
    const id = `lmsg_mock_${String(counter).padStart(6, "0")}`;
    const record: SendRecord = { id, status: "queued", protocol, trace_id: traceparentFor(id) };
    sends.set(id, record);
    return reply.code(200).send(record);
  }

  function getChat(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    if (!authorized(req, config)) return reply.code(401).send({ error: "unauthorized" });
    const { id } = req.params as { id: string };
    const record = sends.get(id);
    // Spec-silent on unknown ids; see NOTES.md.
    if (record === undefined) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send({ id: record.id, status: record.status, protocol: record.protocol });
  }

  function getLines(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    if (!authorized(req, config)) return reply.code(401).send({ error: "unauthorized" });
    // CONTRACTS.md section 11 item 8: this SHAPE IS A GUESS. The adapter's health()
    // must tolerate a different one. Implemented exactly as the spec guesses it.
    const status = config.mode === "banned" ? "banned" : config.mode === "degraded" ? "degraded" : "up";
    return reply.code(200).send({
      lines: [{ id: config.lineId, handle: config.fromHandle, status }],
    });
  }

  for (const rawPrefix of config.pathPrefixes) {
    const prefix = rawPrefix.trim().replace(/\/$/, "");
    app.post(`${prefix}/chats`, postChats);
    app.get(`${prefix}/chats/:id`, getChat);
    app.get(`${prefix}/lines`, getLines);
  }

  async function deliverWebhook(
    rawBody: string | Buffer,
    url?: string,
  ): Promise<{ status: number; signature: string; url: string }> {
    const target = url ?? config.webhookUrl;
    if (target === null || target === undefined || target === "") {
      throw new Error("no webhook url configured (MOCK_LINQ_WEBHOOK_URL)");
    }
    const signature = signBody(rawBody, config.webhookSecret);
    const res = await undiciRequest(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-boi-signature": signature },
      body: rawBody,
    });
    // Drain so the connection is released.
    await res.body.text();
    return { status: res.statusCode, signature, url: target };
  }

  // ---- control plane. Namespaced under /__mock/ so it can never be mistaken for
  // ---- part of the reconstructed Linq surface, and excluded from the recorder.

  app.get("/__mock/requests", async (_req, reply) => reply.send({ requests: recorder.all() }));

  app.delete("/__mock/requests", async (_req, reply) => {
    recorder.clear();
    return reply.code(204).send();
  });

  app.get("/__mock/config", async (_req, reply) =>
    reply.send({
      mode: config.mode,
      line_id: config.lineId,
      from_handle: config.fromHandle,
      retry_after_seconds: config.retryAfterSeconds,
      path_prefixes: config.pathPrefixes,
      webhook_url: config.webhookUrl,
    }),
  );

  app.post("/__mock/webhooks/deliver", async (req, reply) => {
    const raw = (req as RawRequest).rawBody;
    if (raw === undefined) return reply.code(400).send({ error: "validation", detail: "raw body required" });
    const url = (req.query as { url?: string }).url;
    try {
      const result = await deliverWebhook(raw, url);
      return reply.code(200).send({
        delivered_to: result.url,
        signature: result.signature,
        receiver_status: result.status,
      });
    } catch (err) {
      return reply.code(400).send({ error: "validation", detail: (err as Error).message });
    }
  });

  return { app, config, recorder, deliverWebhook };
}

export async function start(config: MockLinqConfig = loadConfig()): Promise<MockLinqServer> {
  const server = buildServer(config);
  await server.app.listen({ port: config.port, host: config.host });
  server.app.log.info(
    { port: config.port, host: config.host, mode: config.mode, line_id: config.lineId },
    "mock-linq listening",
  );
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  start().catch((err: unknown) => {
    console.error(JSON.stringify({ level: "fatal", msg: "mock-linq failed to start", err: String(err) }));
    process.exit(1);
  });
}
