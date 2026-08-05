// The card renderer. CONTRACTS.md § 9 assigns this track port 3042 for exactly this.
//
// A separate process from the API on 3041: rendering is CPU-bound and a slow card must
// not sit in front of a digest upload.

import { timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { digestSchema } from "../../api/src/schemas.js";
import { renderCard } from "./render.js";
import { CARD_HEIGHT, CARD_WIDTH } from "./render.js";
import { putCard, readCard, signedCardPath, verifyCardSignature } from "./store.js";

/**
 * The write secret. **Fails closed when unset**, and that is deliberate.
 *
 * A development default here would be the same mistake as
 * `dev-card-secret-change-me` was for the URL signature: a value that works everywhere,
 * including in production, including for anybody who has read this file. Unset means every
 * write is refused — which breaks the end-to-end runner loudly on the first render rather
 * than quietly accepting writes from the internet.
 */
function writeAuthorised(header: string | string[] | undefined): boolean {
  const expected = process.env["BOI_CARD_WRITE_SECRET"];
  if (expected === undefined || expected === "") return false;
  if (typeof header !== "string" || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(expected, "utf8"));
}

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

  // ---------------------------------------------------------------- prompt 05: hosting
  //
  // `/render` above is unchanged and stays the pure function: digest in, bytes out, and
  // Track D's suite drives it. The two routes below are the hosted half — the same render,
  // stored under a user, and fetchable afterwards by something that is not this process.
  //
  // `POST /cards/:user_id` rather than a flag on `/render` because storing is a different
  // operation with a different lifetime: `/render` has no user and nothing to delete.

  // ---------------------------------------------------------------- the WRITE route
  //
  // `/internal/cards/:user_id`, NOT `/cards/:user_id`, and the prefix is the point.
  //
  // The public hostname is fronted by a Cloudflare tunnel whose ingress matches on
  // hostname and PATH ONLY — a Go regex, `^/cards/`, with no method matching available.
  // A write route sharing that prefix with the read route is forwarded by the edge no
  // matter what verb it carries, because the edge cannot tell them apart. Moving it out
  // of the prefix is what makes the existing rule exclude it.
  //
  // AND it is authenticated anyway, which is not redundancy for its own sake: relying on
  // the edge rule alone means a mistyped regex or a deleted DNS record silently reopens
  // an unauthenticated write into any user's card directory, and nothing in the app would
  // notice. The failure mode is publishing somebody's relationship data.
  app.post("/internal/cards/:user_id", async (req, reply) => {
    if (!writeAuthorised(req.headers["x-boi-card-write"])) {
      // 401 and nothing else. Not "the secret is wrong", not "the secret is unset" — a
      // caller who is not authorised learns only that.
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { user_id: userId } = req.params as { user_id: string };
    if (!/^usr_[A-Za-z0-9]{1,32}$/.test(userId)) {
      return reply.code(400).send({ error: "validation", detail: "user_id" });
    }

    const parsed = digestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation",
        detail: parsed.error.issues.slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }

    const { png, model } = renderCard(parsed.data as never);

    // A REFUSAL CARD IS RENDERED AND NOT STORED. It is a real artifact for the
    // onboarding surface, which renders it on demand; it is not something to keep, and
    // storing it would mean a URL that outlives the moment it was honest in. The caller
    // gets the kind and no URL, and `deliver.ts` attaches nothing.
    if (model.kind === "refusal") {
      return reply.code(200).send({
        kind: "refusal", reason: model.reason, url: null, card_id: null, bytes: png.length,
      });
    }

    const stored = putCard(userId, png);
    // Built from the request's own origin so a caller that reached this server can reach
    // the URL it is handed. `BOI_CARD_PUBLIC_BASE` overrides it for a deployment where
    // the public hostname is not the one the composer dialled.
    // `req.headers.host` and not `req.hostname`: Fastify strips the port from the
    // latter, so the URL came back as `http://127.0.0.1/cards/...` and the fetch that
    // proves the card resolves failed with a bare `TypeError: fetch failed`. A hosted
    // card whose URL does not resolve is the exact defect this route exists to end.
    const host = req.headers.host ?? req.hostname;
    const base = process.env["BOI_CARD_PUBLIC_BASE"] ?? `${req.protocol}://${host}`;
    return reply.code(201).send({
      kind: "standard",
      reason: null,
      card_id: stored.card_id,
      bytes: stored.bytes,
      url: `${base.replace(/\/$/, "")}${signedCardPath(userId, stored.card_id)}`,
    });
  });

  app.get("/cards/:user_id/:file", async (req, reply) => {
    const { user_id: userId, file } = req.params as { user_id: string; file: string };
    const query = req.query as { exp?: string; sig?: string };
    const cardId = file.replace(/\.png$/, "");

    // An unsigned, expired or forged link is 401 and never 404: "this card does not
    // exist" and "you may not have this card" are different answers, and only one of
    // them is safe to give to somebody guessing user ids.
    const expiresAt = Number(query.exp);
    if (typeof query.sig !== "string"
        || !verifyCardSignature(userId, cardId, expiresAt, query.sig)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const png = readCard(userId, cardId);
    // Deleted. A signature that was valid yesterday must not resurrect the bytes, which
    // is the whole point of `deleteUser` reaching outside Postgres.
    if (png === null) return reply.code(404).send({ error: "not_found" });

    return reply.code(200)
      .header("content-type", "image/png")
      .header("cache-control", "private, max-age=300")
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
