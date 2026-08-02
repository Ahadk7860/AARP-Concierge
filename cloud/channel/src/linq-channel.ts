// LinqChannel — the Linq Partner API v3 adapter.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: no provider semantics above the Channel
// interface. Track D emits blocks and never learns whether delivery was blue, green or
// grey. Every Linq noun — parts, protocols, line ids, trace ids, `Retry-After` — either
// stops here or crosses in a field the frozen contract already defines.
//
// The contract is `cloud/shared/src/contracts.ts`, frozen. This file implements it; it
// does not modify it.
//
// There is no Linq token. Every path below is exercised against the mock at
// cloud/mock-linq, which implements contracts/openapi/linq-v3-subset.yaml. That spec has
// never had a live response, so when a token lands the first task is to diff a real
// response against contracts/transcripts/linq/ and amend the contract — not to patch
// this file.

import { request as undiciRequest } from "undici";
import type {
  Capabilities,
  Channel,
  ChannelHealth,
  InboundMessage,
  OutboundBlock,
  OutboundMessage,
  SendResult,
} from "../../shared/src/contracts.js";
import {
  CapabilityError,
  EmptyMessageError,
  LineBannedError,
  RateLimitedError,
  UpstreamError,
} from "./errors.js";
import { RateLimiter, RateLimitExceeded, type LimitBehaviour } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Config — LINQ_BASE_URL drives everything, so production is a one-value swap
// ---------------------------------------------------------------------------

export type LinqChannelConfig = {
  /** CONTRACTS.md section 11 item 1b: this INCLUDES the /api/partner/v3 prefix.
   *  Production is `https://api.linqapp.com/api/partner/v3` and nothing else changes. */
  baseUrl: string;
  token: string;
  fromHandle: string;
  /** The frozen `SendResult` requires a `line_id`, but the documented 200 response to
   *  `POST /chats` carries only id/status/protocol/trace_id — no line. So the adapter
   *  falls back to this configured value when the provider does not say. Recorded as a
   *  contract gap in NOTES.md: not knowing which line carried a message is a real hole,
   *  because a line-level ban is the failure mode that actually hurts. */
  lineId: string;
  requestTimeoutMs: number;
  rateLimit: { maxPerInterval: number; intervalMs: number; behaviour: LimitBehaviour };
  /** Every one of these is a guess. The Linq subset documents no capabilities endpoint,
   *  so they are configuration rather than discovery — which also means the answers from
   *  the sales call land here and not in a code change.
   *
   *  `groups` is false on purpose and is not merely unverified: group sends are out of
   *  MVP scope on consent grounds. */
  capabilities: Capabilities;
};

const DEFAULT_CAPABILITIES: Capabilities = {
  tapbacks: true,
  images: true,
  groups: false,
  typing: false,
  richlinks: true,
  contact_cards: true,
  threading: true,
};

function parseInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${label}: ${raw}`);
  return n;
}

function parseBehaviour(raw: string | undefined): LimitBehaviour {
  if (raw === undefined || raw === "") return "delay";
  if (raw === "delay" || raw === "reject") return raw;
  throw new Error(`invalid CHANNEL_RATE_LIMIT_BEHAVIOUR: ${raw} (expected delay or reject)`);
}

export function loadLinqChannelConfig(env: NodeJS.ProcessEnv = process.env): LinqChannelConfig {
  const baseUrl = env.LINQ_BASE_URL ?? "http://localhost:3031/api/partner/v3";
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token: env.LINQ_API_TOKEN ?? "",
    fromHandle: env.LINQ_FROM_HANDLE ?? "",
    lineId: env.LINQ_LINE_ID ?? "",
    requestTimeoutMs: parseInteger(env.CHANNEL_REQUEST_TIMEOUT_MS, 10_000, "CHANNEL_REQUEST_TIMEOUT_MS"),
    rateLimit: {
      // Conservative on purpose: 30/minute is far above one brief per user per day and
      // far below anything that reads as automation. CONTRACTS.md section 11 item 3.
      maxPerInterval: parseInteger(env.CHANNEL_RATE_LIMIT_MAX, 30, "CHANNEL_RATE_LIMIT_MAX"),
      intervalMs: parseInteger(env.CHANNEL_RATE_LIMIT_INTERVAL_MS, 60_000, "CHANNEL_RATE_LIMIT_INTERVAL_MS"),
      behaviour: parseBehaviour(env.CHANNEL_RATE_LIMIT_BEHAVIOUR),
    },
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

/**
 * `outbound.v1` carries `user_id`, not a handle — the server never holds a raw handle
 * for anyone but the account holder, and the schema is closed (`additionalProperties:
 * false`), so the recipient cannot travel inside the message.
 *
 * The Channel therefore has to be told how to resolve one. Track D owns the users table
 * and injects this. Recorded as a contract gap in NOTES.md.
 */
export type HandleResolver = (userId: string) => Promise<string[]> | string[];

export type LinqChannelDeps = {
  resolveHandles: HandleResolver;
  limiter?: RateLimiter;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Wire shapes — private to this file. None of these types escape upward.
// ---------------------------------------------------------------------------

type LinqTextPart = { type: "text"; text: string };
type LinqMediaPart = { type: "media"; url: string };
type LinqContactPart = { type: "contact_card"; contact: { name: string; handle: string } };
type LinqPart = LinqTextPart | LinqMediaPart | LinqContactPart;

type LinqSendBody = {
  from: string;
  to: string[];
  message: { parts: LinqPart[]; reply_to?: string; protocol: "auto" };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** The spec's three protocol values, narrowed without a cast so an unexpected value
 *  cannot be smuggled into `SendResult`. */
function readProtocol(value: unknown): SendResult["protocol"] | null {
  return value === "imessage" || value === "rcs" || value === "sms" ? value : null;
}

// ---------------------------------------------------------------------------
// Health parsing — tolerant, because the shape is a guess
// ---------------------------------------------------------------------------

// CONTRACTS.md section 11 item 8: the GET /lines shape in the spec is invented and
// health() must tolerate a different one. So this reads defensively across the shapes a
// real API plausibly returns, and — critically — reports `degraded` rather than `up`
// when it cannot understand the answer. Claiming a line is healthy on the strength of a
// response we failed to parse is exactly the confident-wrong-answer failure the product
// rules forbid.

const UP_WORDS = new Set(["up", "ok", "active", "healthy", "enabled", "ready"]);
const BANNED_WORDS = new Set(["banned", "blocked", "suspended", "disabled", "terminated"]);
const DEGRADED_WORDS = new Set(["degraded", "limited", "throttled", "warning", "partial"]);

function classify(word: string): ChannelHealth["status"] | null {
  const normalized = word.trim().toLowerCase();
  if (UP_WORDS.has(normalized)) return "up";
  if (BANNED_WORDS.has(normalized)) return "banned";
  if (DEGRADED_WORDS.has(normalized)) return "degraded";
  return null;
}

/** Pulls the first line-like object out of whichever envelope the provider used. */
export function extractLine(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    const first = payload[0];
    return isRecord(first) ? first : null;
  }
  if (!isRecord(payload)) return null;
  for (const key of ["lines", "data", "items", "results"]) {
    const nested = payload[key];
    if (Array.isArray(nested)) {
      const first = nested[0];
      if (isRecord(first)) return first;
    }
  }
  // A single unwrapped line object.
  if (payload.status !== undefined || payload.state !== undefined || payload.health !== undefined) {
    return payload;
  }
  const line = payload.line;
  return isRecord(line) ? line : null;
}

export function parseHealth(payload: unknown, checkedAt: string): ChannelHealth {
  const line = extractLine(payload);
  if (line === null) return { status: "degraded", line_id: null, checked_at: checkedAt };

  const lineId = readString(line, "id") ?? readString(line, "line_id") ?? null;
  for (const key of ["status", "state", "health"]) {
    const raw = line[key];
    if (typeof raw !== "string") continue;
    const status = classify(raw);
    if (status !== null) return { status, line_id: lineId, checked_at: checkedAt };
  }
  // Understood the envelope, not the verdict. Do not report `up` on a guess.
  return { status: "degraded", line_id: lineId, checked_at: checkedAt };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class LinqChannel implements Channel {
  private readonly config: LinqChannelConfig;
  private readonly resolveHandles: HandleResolver;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;
  /**
   * Idempotency, held in process.
   *
   * The Linq subset documents no idempotency header, so sending one would be inventing
   * wire format — the one thing this track must not do. A caller that retries after a
   * process restart can therefore still double-send; that is a real limit, and it is a
   * question for the sales call rather than something to paper over here.
   */
  private readonly sent = new Map<string, SendResult>();
  private readonly inFlight = new Map<string, Promise<SendResult>>();

  constructor(config: LinqChannelConfig, deps: LinqChannelDeps) {
    this.config = config;
    this.resolveHandles = deps.resolveHandles;
    this.now = deps.now ?? (() => new Date());
    this.limiter =
      deps.limiter ??
      new RateLimiter({
        maxPerInterval: config.rateLimit.maxPerInterval,
        intervalMs: config.rateLimit.intervalMs,
        behaviour: config.rateLimit.behaviour,
      });
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const cached = this.sent.get(msg.idempotency_key);
    if (cached !== undefined) return cached;
    const pending = this.inFlight.get(msg.idempotency_key);
    if (pending !== undefined) return pending;

    const attempt = this.performSend(msg);
    this.inFlight.set(msg.idempotency_key, attempt);
    try {
      const result = await attempt;
      this.sent.set(msg.idempotency_key, result);
      return result;
    } finally {
      this.inFlight.delete(msg.idempotency_key);
    }
  }

  private async performSend(msg: OutboundMessage): Promise<SendResult> {
    const capabilities = await this.capabilities();
    const to = await this.resolveHandles(msg.user_id);

    if (to.length === 0) throw new UpstreamError("no_recipient", null, null, `no handle for ${msg.user_id}`);
    if (to.length > 1 && !capabilities.groups) {
      // Refused, not attempted. A group send that quietly fans out to individuals is a
      // consent violation, not a formatting problem.
      throw new CapabilityError("groups", `group send refused: ${to.length} recipients, groups unsupported`);
    }

    const parts = toParts(msg.blocks, capabilities);
    if (parts.length === 0) throw new EmptyMessageError();

    const body: LinqSendBody = {
      from: this.config.fromHandle,
      to,
      message: { parts, protocol: "auto" },
    };
    // Threading is negotiated, not assumed: without it the reply reference is dropped
    // and the message still sends.
    if (capabilities.threading && typeof msg.reply_to_message_id === "string") {
      body.message.reply_to = msg.reply_to_message_id;
    }

    await this.acquirePermit();
    const response = await this.post("/chats", body);
    return this.toSendResult(response);
  }

  async capabilities(): Promise<Capabilities> {
    // Configuration, not discovery: the Linq subset documents no capabilities endpoint.
    // Returned as a copy so a caller cannot mutate the adapter's view of its own line.
    return { ...this.config.capabilities };
  }

  async health(): Promise<ChannelHealth> {
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.get("/lines");
      if (response.status === 200) return parseHealth(response.body, checkedAt);
      const failure = readFailure(response.body);
      if (failure.error === "line_banned") {
        return { status: "banned", line_id: failure.lineId, checked_at: checkedAt };
      }
      return { status: "degraded", line_id: failure.lineId, checked_at: checkedAt };
    } catch {
      // Unreachable is not healthy, and it is not proven banned either.
      return { status: "degraded", line_id: null, checked_at: checkedAt };
    }
  }

  normalizeInbound(_rawBody: unknown, _signature: string): InboundMessage {
    // Prompt 03 owns this. It throws rather than returning a partial message because
    // the frozen contract says "never returns a partially-normalized message", and a
    // plausible-looking stub is worse than an absent one: Track D would build against
    // fabricated inbound and nobody would notice until integration.
    throw new Error("not_implemented: inbound normalization lands in Track C prompt 03");
  }

  // ---- transport ---------------------------------------------------------

  private async acquirePermit(): Promise<void> {
    try {
      await this.limiter.acquire();
    } catch (err) {
      if (err instanceof RateLimitExceeded) {
        throw new RateLimitedError(Math.ceil(err.waitMs / 1000), true, err.message);
      }
      throw err;
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      "content-type": "application/json",
    };
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await undiciRequest(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      headersTimeout: this.config.requestTimeoutMs,
      bodyTimeout: this.config.requestTimeoutMs,
    });
    return { status: res.statusCode, body: await readJson(res) };
  }

  /** Sends, and translates every documented failure into a typed error. Nothing below
   *  this method returns a raw provider status to the caller. */
  private async post(path: string, body: LinqSendBody): Promise<Record<string, unknown>> {
    let status: number;
    let payload: unknown;
    let retryAfter: string | undefined;
    try {
      const res = await undiciRequest(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        headersTimeout: this.config.requestTimeoutMs,
        bodyTimeout: this.config.requestTimeoutMs,
      });
      status = res.statusCode;
      const header = res.headers["retry-after"];
      retryAfter = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
      payload = await readJson(res);
    } catch (err) {
      throw new UpstreamError("transport", null, null, `transport failure: ${String(err)}`);
    }

    if (status === 200) {
      if (!isRecord(payload)) throw new UpstreamError("malformed_response", status, null, "response was not an object");
      return payload;
    }

    const failure = readFailure(payload);
    if (status === 429) {
      const parsed = retryAfter === undefined ? Number.NaN : Number.parseInt(retryAfter, 10);
      throw new RateLimitedError(Number.isInteger(parsed) ? parsed : null, false);
    }
    if (status === 401 || status === 403) throw new UpstreamError("unauthorized", status, failure.lineId);
    if (status === 503 && failure.error === "line_banned") throw new LineBannedError(failure.lineId);
    throw new UpstreamError(failure.error ?? `http_${status}`, status, failure.lineId);
  }

  /** Narrows the provider's response into the frozen `SendResult`, dropping every field
   *  the contract does not name. `trace_id` in particular stops here: it is a Linq
   *  correlation id and Track D has no use for it that would not be provider coupling. */
  private toSendResult(payload: Record<string, unknown>): SendResult {
    const id = readString(payload, "id");
    const protocol = readProtocol(payload["protocol"]);
    if (id === null) throw new UpstreamError("malformed_response", 200, null, "response carried no id");
    if (protocol === null) {
      throw new UpstreamError("malformed_response", 200, null, `unrecognized protocol: ${String(payload["protocol"])}`);
    }
    return {
      message_id: id,
      provider: "linq",
      protocol,
      // The provider does not report a line on a send. Falls back to config; see the
      // contract gap noted on LinqChannelConfig.lineId.
      line_id: readString(payload, "line_id") ?? this.config.lineId,
    };
  }
}

function readFailure(payload: unknown): { error: string | null; lineId: string | null } {
  if (!isRecord(payload)) return { error: null, lineId: null };
  return { error: readString(payload, "error"), lineId: readString(payload, "line_id") };
}

async function readJson(res: { body: { text(): Promise<string> } }): Promise<unknown> {
  const text = await res.body.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Blocks to parts, with unsupported features degrading silently rather than failing the
 * send. Negotiation, not assumption: `requested_capabilities` on the message is
 * advisory and is deliberately not consulted here — what the line can actually do is
 * what governs.
 */
function toParts(blocks: OutboundBlock[], capabilities: Capabilities): LinqPart[] {
  const parts: LinqPart[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      // `alt` has nowhere to go in the Linq media part; dropping it loses accessibility
      // text, which is a real cost and is recorded in NOTES.md rather than hidden.
      if (capabilities.images) parts.push({ type: "media", url: block.url });
    } else {
      if (capabilities.contact_cards) {
        parts.push({ type: "contact_card", contact: { name: block.name, handle: block.handle } });
      }
    }
  }
  return parts;
}
