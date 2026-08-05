import type { FastifyInstance } from "fastify";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCardServer } from "./server.js";

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
  const rawPort = required("PORT", "3042");
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

export async function startCardRuntime(
  config: CardRuntimeConfig = loadCardRuntimeConfig(),
  options: {
    build?: () => FastifyInstance;
    listen?: (app: FastifyInstance, input: { host: string; port: number }) => Promise<void>;
    prepareStorage?: (directory: string) => Promise<void>;
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
  app.get("/healthz", async () => ({ status: "ok" }));
  try {
    await (options.listen ?? ((server, input) => server.listen(input).then(() => undefined)))(
      app,
      { host: config.host, port: config.port },
    );
  } catch (error) {
    try { await app.close(); } catch { /* preserve the listener failure */ }
    throw error;
  }
  return { app, close: () => app.close() };
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const runtime = await startCardRuntime();
  const shutdown = () => { void runtime.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
