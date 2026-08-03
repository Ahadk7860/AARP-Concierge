// The card renderer. CONTRACTS.md § 9 assigns this track port 3042 for exactly this.
//
// A separate process from the API on 3041: rendering is CPU-bound and a slow card must
// not sit in front of a digest upload.

import Fastify, { type FastifyInstance } from "fastify";
import { digestSchema } from "../../api/src/schemas.js";
import { renderCard } from "./render.js";
import { CARD_HEIGHT, CARD_WIDTH } from "./render.js";

export function buildCardServer(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === "number" ? e.statusCode : 500;
    const detail = typeof e.message === "string" ? e.message : "malformed request";
    if (status === 400) return reply.code(400).send({ error: "validation", detail });
    return reply.code(status).send({ error: "internal" });
  });

  app.post("/render", async (req, reply) => {
    // The same zod mirror the ingest route uses, so the card cannot accept a digest
    // the API would have rejected — and `differential.test.ts` keeps that mirror
    // honest against the frozen JSON Schema.
    const parsed = digestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation",
        detail: parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
    }

    const { png, model } = renderCard(parsed.data as never);

    // A refusal is still a card-shaped PNG — the user gets an honest page rather than
    // an error — but the header says which it was, so a caller can tell without
    // decoding the image. Prompt 05 needs that to decide whether to attach one.
    return reply
      .code(200)
      .header("content-type", "image/png")
      .header("x-boi-card-kind", model.kind)
      .header("x-boi-card-width", String(CARD_WIDTH))
      .header("x-boi-card-height", String(CARD_HEIGHT))
      .header(
        "x-boi-card-reason",
        model.kind === "refusal" ? model.reason : "",
      )
      .send(png);
  });

  return app;
}

export const CARD_PORT = Number(process.env["CARD_PORT"] ?? 3042);

if (process.argv[1] !== undefined && process.argv[1].endsWith("card/src/server.js")) {
  const app = buildCardServer();
  await app.listen({ port: CARD_PORT, host: "127.0.0.1" });
  process.stdout.write(
    `${JSON.stringify({ level: "info", msg: "card renderer listening", port: CARD_PORT })}\n`,
  );
}
