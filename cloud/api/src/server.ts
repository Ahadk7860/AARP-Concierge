// The Track D API. CONTRACTS.md § 9 assigns this track port 3041 — never a framework
// default, because another track is running right now and would pick the same one.

import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { StubChannel, type Channel } from "../../shared/src/index.js";
import { makeLogger } from "./logging.js";
import { send, validation } from "./errors.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerSignupRoutes, type Clock } from "./routes/signup.js";
import { registerWebhookRoutes } from "./routes/webhook.js";

export type BuildOptions = {
  /** Pass a pino destination to capture log output — see the no-user-content test. */
  logger?: Logger;
  /**
   * Track C's adapter drops in behind this interface. Until it exists, `StubChannel`
   * from the foundation — CONTRACTS.md § 10. Nothing above the interface knows which.
   */
  channel?: Channel;
  /** Injected so pairing expiry is tested by moving the clock, not by sleeping. */
  now?: Clock;
};

export function buildServer(options: BuildOptions = {}): FastifyInstance {
  const log = options.logger ?? makeLogger();
  const channel = options.channel ?? new StubChannel();
  const now = options.now ?? (() => new Date());

  // Fastify's own request logging is off: it would log the URL and headers on every
  // request, and this API's job is to be careful about what reaches a log sink.
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // A malformed JSON body is a validation error, not a 500 and not Fastify's own
  // default shape — CONTRACTS.md § 6 fixes the error body for every endpoint.
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === "number" ? e.statusCode : 500;
    const message = typeof e.message === "string" ? e.message : "malformed request";
    if (status === 400) return send(reply, 400, validation(message));
    // The message, never the body: a 500 during a voice-pack upload must not spill
    // exemplars into the log sink.
    log.error({ err: message, status }, "unhandled");
    return reply.code(status).send({ error: "internal" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  // THE RAW BODY PARSER, REGISTERED BEFORE ANYTHING ELSE TOUCHES application/json.
  //
  // Track C's `normalizeInbound` verifies a signature over the bytes that arrived.
  // Fastify's default JSON parser hands a handler an object, and re-serialising it is
  // not the same bytes — key order, whitespace and number formatting all move — so the
  // signature never matches and the real adapter throws RawBodyRequiredError.
  //
  // This replaces the default parser for the whole service: it keeps the raw string on
  // `req.rawBody` AND returns the parsed object, so every other route is unaffected.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      if ((body as string).length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        // A 400 with the documented validation shape, not Fastify's default body.
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // The HTML signup form posts urlencoded, which Fastify does not parse by default.
  // Parsed into the same shape a JSON client sends, so one schema validates both.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerIngestRoutes(app, log);
  registerSignupRoutes(app, log, { channel, now });
  registerWebhookRoutes(app, log, { channel });
  return app;
}

export const API_PORT = Number(process.env["API_PORT"] ?? 3041);

/** `node --env-file=.env dist/cloud/api/src/server.js` — see cloud/db/README.md. */
if (process.argv[1] !== undefined && process.argv[1].endsWith("server.js")) {
  const app = buildServer();
  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  process.stdout.write(
    `${JSON.stringify({ level: "info", msg: "listening", port: API_PORT })}\n`,
  );
}
