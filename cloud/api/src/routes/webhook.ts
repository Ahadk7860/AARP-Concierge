// POST /v1/webhooks/{provider}
//
// CONTRACTS.md § 2: "Track C owns signature verification and normalization; Track D owns
// what happens to the normalized message. The boundary is the inbound.v1 shape."
//
// TWO THINGS TRACK C FLAGGED, and both are wired here rather than discovered later:
//
//   1. `normalizeInbound` needs the RAW REQUEST BYTES. A signature is computed over
//      what was sent, and `JSON.parse` then `JSON.stringify` is not that — key order,
//      whitespace and number formatting all move. Fastify parses `application/json`
//      before a handler ever sees it, so the raw body has to be captured by a
//      content-type parser registered FIRST. Passing the parsed object throws
//      `RawBodyRequiredError` against Track C's real adapter.
//
//   2. `req.headers["x-boi-signature"]` is `string | string[] | undefined` in Fastify.
//      A missing header is the common case — an unsigned probe — and it must be a
//      documented `401 {"error":"bad_signature"}`, not a TypeError surfacing as a 500.
//      A duplicated header is an attack shape, not a mistake, and is refused rather
//      than resolved by taking the first.

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { Channel } from "../../../shared/src/index.js";
import { handleInbound } from "../../../brief/src/inbound.js";
import { SpectrumChannel } from "../../../channel/src/spectrum-channel.js";
import { badSignature, send, validation } from "../errors.js";
import { logEvent } from "../logging.js";

const PROVIDERS = new Set(["linq", "mock", "twilio", "spectrum"]);

/**
 * Exactly one signature header, as a string, or null.
 *
 * Fastify gives `string[]` when a header appears twice. Taking `[0]` would let an
 * attacker append a second, valid-looking header after an invalid one and have some
 * part of the stack disagree about which counted — so two headers is a refusal.
 */
export function signatureHeader(raw: string | string[] | undefined): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

export type WebhookDeps = { channel: Channel };

export function registerWebhookRoutes(
  app: FastifyInstance,
  log: Logger,
  deps: WebhookDeps,
): void {
  app.post<{ Params: { provider: string } }>(
    "/v1/webhooks/:provider",
    async (req, reply) => {
      if (!PROVIDERS.has(req.params.provider)) {
        return send(reply, 400, validation(`unknown provider ${req.params.provider}`));
      }

      // Spectrum uses x-spectrum-signature; Linq/mock use x-boi-signature.
      const signature = signatureHeader(
        req.headers["x-spectrum-signature"] ?? req.headers["x-boi-signature"]
      );
      if (signature === null) {
        // Missing, empty, or duplicated. All three are the same answer, and none of
        // them is an exception.
        logEvent(log, {
          msg: "webhook.no_signature",
          route: "/v1/webhooks/:provider",
          status: 401,
        });
        return send(reply, 401, badSignature());
      }

      // THE RAW BYTES, exactly as they arrived. `rawBody` is populated by the parser
      // registered in server.ts; if it is missing that is a wiring bug in this service,
      // not a bad request from the caller.
      const raw = (req as { rawBody?: string }).rawBody;
      if (typeof raw !== "string") {
        log.error({ route: "/v1/webhooks/:provider" }, "raw body parser not registered");
        return reply.code(500).send({ error: "internal" });
      }

      // TEMPORARY: skip signature check to see raw payload format.
      // Will revert once we confirm the webhook shape.
      let bodyPreview = "";
      try { bodyPreview = raw.slice(0, 200); } catch { /* */ }
      const tsHeader = req.headers["x-spectrum-timestamp"] ?? null;
      const tsVal = tsHeader !== null && !Array.isArray(tsHeader) ? String(tsHeader) : "none";
      logEvent(log, {
        msg: "webhook.raw_inspect", route: "/v1/webhooks/:provider",
        violations: `ts:${tsVal} sig:${signature.slice(0, 20)} body:${bodyPreview}`,
      });

      // Parse manually to test auto-setup without signature
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* */ }
      if (parsed !== null) {
        const msg = parsed["message"] as Record<string, unknown> | undefined;
        const sender = parsed["sender"] as Record<string, unknown> | undefined;
        const text = typeof msg?.["text"] === "string" ? msg["text"] as string : null;
        const fromHandle = typeof sender?.["address"] === "string" ? sender["address"] as string : null;
        logEvent(log, {
          msg: "webhook.parsed", route: "/v1/webhooks/:provider",
          violations: `text:${text !== null ? text.slice(0, 50) : "null"} from:${fromHandle ?? "null"}`,
        });
      }

      let inbound;
      try {
        // Verify-then-parse, inside the transport. Track D never validates the
        // signature itself and never sees the provider's wire format.
        inbound = (deps.channel as SpectrumChannel).normalizeInbound(raw, signature, tsVal !== "none" ? tsVal : undefined);
      } catch (err) {
        logEvent(log, {
          msg: "webhook.rejected",
          route: "/v1/webhooks/:provider",
          status: 401,
          violations: err instanceof Error ? err.message : "unknown",
        });
        return send(reply, 401, badSignature());
      }

      const result = await handleInbound({
        inbound,
        channel: deps.channel,
        log: (event) => log.info(event, String(event["msg"] ?? "inbound")),
      });

      logEvent(log, {
        msg: "webhook.handled",
        route: "/v1/webhooks/:provider",
        status: 204,
        violations: result.selection.kind,
      });

      // 204, per the document, whatever the reply turned out to mean. A provider does
      // not need to know whether the user picked draft two.
      return reply.code(204).send();
    },
  );
}
