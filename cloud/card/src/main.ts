import type { FastifyInstance } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCardServer } from "./server.js";
import { countCardsFor, deleteCardsFor } from "./store.js";

export type CardRuntimeConfig = {
  host: "0.0.0.0";
  port: number;
  cardDir: string;
  signingSecret: string;
  writeSecret: string;
  publicBase: string;
  volumeMountPath: string | null;
};

export function loadCardRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CardRuntimeConfig {
  const production = env["NODE_ENV"] === "production";
  const required = (name: string, developmentFallback?: string): string => {
    const value = env[name]?.trim();
    if (value) return value;
    if (!production && developmentFallback !== undefined) return developmentFallback;
    throw new Error(`${name} is required for the card runtime`);
  };
  const rawPort = production ? required("PORT") : (env["CARD_PORT"]?.trim() || env["PORT"]?.trim() || "3042");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535 for the card runtime");
  }
  const publicBase = required("BOI_CARD_PUBLIC_BASE", "http://127.0.0.1:3042");
  const parsedBase = new URL(publicBase);
  if (production && parsedBase.protocol !== "https:") {
    throw new Error("BOI_CARD_PUBLIC_BASE must use https in production");
  }
  const cardDir = required("BOI_CARD_DIR", "/tmp/boi-e/cards");
  if (!cardDir.startsWith("/")) throw new Error("BOI_CARD_DIR must be absolute");
  const volumeMountPath = env["RAILWAY_VOLUME_MOUNT_PATH"]?.trim() || null;
  if (production && volumeMountPath === null) {
    throw new Error("RAILWAY_VOLUME_MOUNT_PATH is required for persistent hosted cards");
  }
  if (volumeMountPath !== null && volumeMountPath !== cardDir) {
    throw new Error("BOI_CARD_DIR must equal RAILWAY_VOLUME_MOUNT_PATH");
  }
  return {
    host: "0.0.0.0",
    port,
    cardDir,
    signingSecret: required("BOI_CARD_SIGNING_SECRET", "dev-card-secret-change-me"),
    writeSecret: required("BOI_CARD_WRITE_SECRET", "dev-card-write-secret-change-me"),
    publicBase,
    volumeMountPath,
  };
}

export async function probeCardStorage(directory: string): Promise<boolean> {
  const file = resolve(directory, `.boi-ready-${randomBytes(12).toString("hex")}`);
  const expected = randomBytes(32);
  try {
    await writeFile(file, expected, { mode: 0o600, flag: "wx" });
    const actual = await readFile(file);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  } finally {
    try { await unlink(file); } catch { /* a failed create has nothing to clean */ }
  }
}

function authenticWriteSecret(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const given = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function startCardRuntime(
  config: CardRuntimeConfig = loadCardRuntimeConfig(),
  options: {
    build?: () => FastifyInstance;
    listen?: (app: FastifyInstance, input: { host: string; port: number }) => Promise<void>;
    prepareStorage?: (directory: string) => Promise<void>;
    storageReady?: (directory: string) => Promise<boolean>;
    deleteCards?: (userId: string) => number;
    countCards?: (userId: string) => number;
  } = {},
): Promise<{ app: FastifyInstance; close(): Promise<void> }> {
  // The existing card store reads these at operation time. Set only validated values.
  process.env["BOI_CARD_DIR"] = config.cardDir;
  process.env["BOI_CARD_SIGNING_SECRET"] = config.signingSecret;
  process.env["BOI_CARD_WRITE_SECRET"] = config.writeSecret;
  process.env["BOI_CARD_PUBLIC_BASE"] = config.publicBase;
  await (options.prepareStorage ?? (async (directory) => {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK | constants.W_OK);
  }))(config.cardDir);
  const app = (options.build ?? buildCardServer)();
  let closing = false;
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const ready = !closing && await (options.storageReady ?? probeCardStorage)(config.cardDir);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unready" });
  });
  app.delete("/internal/cards/:user_id", async (request, reply) => {
    if (!authenticWriteSecret(request.headers["x-boi-card-write"], config.writeSecret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { user_id: userId } = request.params as { user_id: string };
    if (!/^usr_[0-9A-Za-z]{8,32}$/.test(userId)) {
      return reply.code(400).send({ error: "invalid_user" });
    }
    (options.deleteCards ?? deleteCardsFor)(userId);
    const remaining = (options.countCards ?? countCardsFor)(userId);
    if (remaining !== 0) return reply.code(500).send({ error: "residue" });
    return reply.code(200).send({ remaining: 0 });
  });
  try {
    await (options.listen ?? ((server, input) => server.listen(input).then(() => undefined)))(
      app,
      { host: config.host, port: config.port },
    );
  } catch (error) {
    try { await app.close(); } catch { /* preserve the listener failure */ }
    throw error;
  }
  return {
    app,
    async close() {
      if (closing) return;
      closing = true;
      await app.close();
    },
  };
}

export function shouldStartCardProcess(
  metaUrl = import.meta.url,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(metaUrl))
    || env["npm_lifecycle_event"] === "card"
    || (env["CARD_PORT"] !== undefined && argv[1]?.endsWith("/vite-node.mjs") === true);
}

if (shouldStartCardProcess()) {
  const runtime = await startCardRuntime();
  const shutdown = () => { void runtime.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
