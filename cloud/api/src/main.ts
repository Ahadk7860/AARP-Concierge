// Production composition root. Routes remain independently testable through
// buildServer; this file is the only place allowed to choose live dependencies.

import type { FastifyInstance } from "fastify";
import type { Channel, Registrar } from "../../shared/src/index.js";
import { StubChannel, StubRegistrar } from "../../shared/src/index.js";
import { closePool, getPool, type Queryable } from "../../db/src/index.js";
import { SpectrumChannel } from "../../channel/src/spectrum-channel.js";
import { LiveSpectrumPort, connectSpectrum } from "../../channel/src/spectrum-live.js";
import { SpectrumRegistrar } from "../../channel/src/spectrum-registrar.js";
import { registerHealthRoutes, type RuntimeStatus } from "./health.js";
import { buildServer } from "./server.js";

type SpectrumConfig = {
  projectId: string;
  projectSecret: string;
  lineE164: string;
  webhookSecret: string;
};

export type RuntimeConfig = {
  production: boolean;
  host: "0.0.0.0";
  port: number;
  databaseUrl: string | null;
  contactKeyEnvelopeMasterKey: Buffer | null;
  spectrum: SpectrumConfig | null;
};

export class RuntimeConfigError extends Error {
  constructor(readonly missing: readonly string[], readonly invalid: readonly string[] = []) {
    super(`invalid runtime configuration: ${[...missing, ...invalid].join(", ")}`);
  }
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function portFrom(env: NodeJS.ProcessEnv, required: boolean): { value: number; invalid: string[] } {
  const raw = nonEmpty(env, "PORT");
  if (raw === null) return { value: 3041, invalid: required ? ["PORT (required)"] : [] };
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535
    ? { value, invalid: [] }
    : { value: 3041, invalid: ["PORT (must be an integer from 1 to 65535)"] };
}

/**
 * Parse all deployment inputs before opening a network connection. Production has no
 * stub mode: a missing secret is a boot failure, not an app that appears healthy.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env["NODE_ENV"] === "production";
  const missing: string[] = [];
  const invalid: string[] = [];
  const port = portFrom(env, production);
  invalid.push(...port.invalid);

  const databaseUrl = nonEmpty(env, "DATABASE_URL");
  if (databaseUrl !== null) {
    try {
      const parsed = new URL(databaseUrl);
      if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
        invalid.push("DATABASE_URL (must use postgres)");
      }
    } catch {
      invalid.push("DATABASE_URL (must be a URL)");
    }
  } else if (production) {
    missing.push("DATABASE_URL");
  }

  const masterKey = nonEmpty(env, "CONTACT_KEY_ENVELOPE_MASTER_KEY");
  let contactKeyEnvelopeMasterKey: Buffer | null = null;
  if (masterKey !== null) {
    const decoded = Buffer.from(masterKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== masterKey) {
      invalid.push("CONTACT_KEY_ENVELOPE_MASTER_KEY (must be a canonical base64 32-byte key)");
    } else {
      contactKeyEnvelopeMasterKey = decoded;
    }
  } else if (production) {
    missing.push("CONTACT_KEY_ENVELOPE_MASTER_KEY");
  }

  const projectId = nonEmpty(env, "SPECTRUM_PROJECT_ID");
  const projectSecret = nonEmpty(env, "SPECTRUM_PROJECT_SECRET");
  const lineE164 = nonEmpty(env, "SPECTRUM_LINE_E164");
  const webhookSecret = nonEmpty(env, "SPECTRUM_WEBHOOK_SECRET");
  const spectrumValues = [projectId, projectSecret, lineE164, webhookSecret];
  const configuredSpectrum = spectrumValues.some((value) => value !== null);
  if (configuredSpectrum || production) {
    for (const [name, value] of [
      ["SPECTRUM_PROJECT_ID", projectId],
      ["SPECTRUM_PROJECT_SECRET", projectSecret],
      ["SPECTRUM_LINE_E164", lineE164],
      ["SPECTRUM_WEBHOOK_SECRET", webhookSecret],
    ] as const) {
      if (value === null) missing.push(name);
    }
    if (lineE164 !== null && !/^\+[1-9][0-9]{6,14}$/.test(lineE164)) {
      invalid.push("SPECTRUM_LINE_E164 (must be E.164)");
    }
  }

  if (missing.length > 0 || invalid.length > 0) throw new RuntimeConfigError(missing, invalid);

  return {
    production,
    host: "0.0.0.0",
    port: port.value,
    databaseUrl,
    contactKeyEnvelopeMasterKey,
    spectrum: configuredSpectrum && projectId && projectSecret && lineE164 && webhookSecret
      ? { projectId, projectSecret, lineE164, webhookSecret }
      : null,
  };
}

type RuntimeDeps = {
  channel?: Channel;
  registrar?: Registrar;
  db?: Queryable;
  closeDb?: () => Promise<void>;
  connectLiveSpectrum?: typeof connectSpectrum;
};

type SpaceRow = { phone_e164: string; channel_space_id: string | null };

async function spectrumSpaceFor(db: Queryable, userId: string): Promise<{ handle: string; spaceId: string | null }> {
  const result = await db.query<SpaceRow>(
    "select phone_e164, channel_space_id from users where user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("spectrum_user_not_found");
  return { handle: row.phone_e164, spaceId: row.channel_space_id };
}

async function rememberSpectrumSpace(db: Queryable, userId: string, spaceId: string): Promise<void> {
  await db.query(
    "update users set channel_space_id = $2 where user_id = $1",
    [userId, spaceId],
  );
}

export type RunningRuntime = {
  app: FastifyInstance;
  close(): Promise<void>;
};

/** Start the API with live dependencies whenever their required configuration exists. */
export async function startRuntime(
  config: RuntimeConfig = loadRuntimeConfig(),
  deps: RuntimeDeps = {},
): Promise<RunningRuntime> {
  const db = deps.db ?? getPool();
  const closeDb = deps.closeDb ?? closePool;
  let channel = deps.channel;
  let registrar = deps.registrar;
  let stopSpectrum: (() => Promise<void>) | null = null;
  if (channel === undefined || registrar === undefined) {
    if (config.spectrum !== null) {
      const connected = await (deps.connectLiveSpectrum ?? connectSpectrum)();
      stopSpectrum = connected.stop;
      const port = new LiveSpectrumPort(connected.spaces);
      channel ??= new SpectrumChannel({
        port,
        spaceFor: (userId) => spectrumSpaceFor(db, userId),
        rememberSpace: (userId, spaceId) => rememberSpectrumSpace(db, userId, spaceId),
      });
      registrar ??= new SpectrumRegistrar(port, config.spectrum.lineE164);
    } else if (!config.production) {
      channel ??= new StubChannel();
      registrar ??= new StubRegistrar();
    } else {
      throw new RuntimeConfigError(["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "SPECTRUM_LINE_E164", "SPECTRUM_WEBHOOK_SECRET"]);
    }
  }

  let closing = false;
  const ready = async (): Promise<boolean> => {
    if (closing) return false;
    try {
      await db.query("select 1");
      return (await channel.health()).status === "up";
    } catch {
      return false;
    }
  };

  // Never publish a listener that has not reached its database and channel dependencies.
  if (!(await ready())) {
    if (stopSpectrum !== null) await stopSpectrum();
    await closeDb();
    throw new Error("runtime_dependencies_unready");
  }

  const status: RuntimeStatus = { live: () => !closing, ready };
  const app = buildServer({ channel, registrar });
  registerHealthRoutes(app, status);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    closing = true;
    await app.close();
    if (stopSpectrum !== null) await stopSpectrum();
    await closeDb();
    throw error;
  }

  return {
    app,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      await app.close();
      if (stopSpectrum !== null) await stopSpectrum();
      await closeDb();
    },
  };
}

if (process.argv[1]?.endsWith("main.js") || process.argv[1]?.endsWith("main.ts")) {
  const runtime = await startRuntime();
  const shutdown = async () => {
    await runtime.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
