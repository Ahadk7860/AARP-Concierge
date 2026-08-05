// Production composition root. Every secret is parsed once, then passed explicitly to
// the dependency that consumes it. No production path can select a stub.

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Spectrum, type Space } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

import type {
  Capabilities,
  Channel,
  ChannelHealth,
  InboundMessage,
  OutboundMessage,
  Registrar,
  SendResult,
} from "../../shared/src/index.js";
import { StubChannel, StubRegistrar } from "../../shared/src/index.js";
import type { Queryable } from "../../db/src/index.js";
import { SpectrumChannel } from "../../channel/src/spectrum-channel.js";
import { LiveSpectrumPort } from "../../channel/src/spectrum-live.js";
import { SpectrumRegistrar } from "../../channel/src/spectrum-registrar.js";
import {
  registerHealthRoutes,
  type ComponentState,
  type ReadinessSnapshot,
  type RuntimeStatus,
} from "./health.js";
import { buildServer } from "./server.js";

export type SpectrumConfig = {
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
  readinessTimeoutMs: number;
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

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  required = false,
): { value: number; invalid: string[] } {
  const raw = nonEmpty(env, name);
  if (raw === null) return { value: fallback, invalid: required ? [`${name} (required)`] : [] };
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? { value, invalid: [] }
    : { value: fallback, invalid: [`${name} (must be an integer from ${min} to ${max})`] };
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env["NODE_ENV"] === "production";
  const missing: string[] = [];
  const invalid: string[] = [];
  const port = integerSetting(env, "PORT", 3041, 1, 65535, production);
  const readinessTimeout = integerSetting(env, "READINESS_TIMEOUT_MS", 2_000, 10, 30_000);
  invalid.push(...port.invalid, ...readinessTimeout.invalid);

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
  } else if (production) missing.push("DATABASE_URL");

  const masterKey = nonEmpty(env, "CONTACT_KEY_ENVELOPE_MASTER_KEY");
  let contactKeyEnvelopeMasterKey: Buffer | null = null;
  if (masterKey !== null) {
    const decoded = Buffer.from(masterKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== masterKey) {
      invalid.push("CONTACT_KEY_ENVELOPE_MASTER_KEY (must be a canonical base64 32-byte key)");
    } else contactKeyEnvelopeMasterKey = decoded;
  } else if (production) missing.push("CONTACT_KEY_ENVELOPE_MASTER_KEY");

  const projectId = nonEmpty(env, "SPECTRUM_PROJECT_ID");
  const projectSecret = nonEmpty(env, "SPECTRUM_PROJECT_SECRET");
  const lineE164 = nonEmpty(env, "SPECTRUM_LINE_E164");
  const webhookSecret = nonEmpty(env, "SPECTRUM_WEBHOOK_SECRET");
  const configuredSpectrum = [projectId, projectSecret, lineE164, webhookSecret]
    .some((value) => value !== null);
  if (configuredSpectrum || production) {
    for (const [name, value] of [
      ["SPECTRUM_PROJECT_ID", projectId],
      ["SPECTRUM_PROJECT_SECRET", projectSecret],
      ["SPECTRUM_LINE_E164", lineE164],
      ["SPECTRUM_WEBHOOK_SECRET", webhookSecret],
    ] as const) if (value === null) missing.push(name);
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
    readinessTimeoutMs: readinessTimeout.value,
  };
}

/** Track I receives this capability, not the platform secret itself. */
export type HandleEnvelopeKeyProvider = {
  keyId: string;
  key(): Buffer;
};

export function createHandleEnvelopeKeyProvider(masterKey: Buffer): HandleEnvelopeKeyProvider {
  const held = Buffer.from(masterKey);
  return {
    keyId: createHash("sha256").update(held).digest("hex").slice(0, 16),
    key: () => Buffer.from(held),
  };
}

type SpaceOps = { create(handle: string): Promise<Space>; get(id: string): Promise<Space> };
type DatabaseResource = { db: Queryable; close(): Promise<void> };
type SpectrumResource = { spaces: SpaceOps; stop(): Promise<void> };
type RuntimeLog = (event: { msg: string; component?: string; outcome?: string }) => void;

export type RuntimeFactories = {
  openDatabase(url: string): Promise<DatabaseResource>;
  connectSpectrum(config: SpectrumConfig): Promise<SpectrumResource>;
  createKeyProvider(key: Buffer): HandleEnvelopeKeyProvider;
  createSpectrumChannel(input: {
    port: LiveSpectrumPort;
    db: Queryable;
    webhookSecret: string;
  }): Channel;
  listen(app: FastifyInstance, options: { host: string; port: number }): Promise<void>;
  closeApp(app: FastifyInstance): Promise<void>;
  log: RuntimeLog;
};

const LOCAL_DATABASE_URL = "postgres://localhost:5432/boi_dev_d";

class WebhookSecretChannel implements Channel {
  constructor(private readonly delegate: Channel, private readonly webhookSecret: string) {}
  send(message: OutboundMessage): Promise<SendResult> { return this.delegate.send(message); }
  capabilities(): Promise<Capabilities> { return this.delegate.capabilities(); }
  health(): Promise<ChannelHealth> { return this.delegate.health(); }
  normalizeInbound(rawBody: Buffer | string, signature: string): InboundMessage {
    const previous = process.env["SPECTRUM_WEBHOOK_SECRET"];
    process.env["SPECTRUM_WEBHOOK_SECRET"] = this.webhookSecret;
    try {
      return this.delegate.normalizeInbound(rawBody, signature);
    } finally {
      if (previous === undefined) delete process.env["SPECTRUM_WEBHOOK_SECRET"];
      else process.env["SPECTRUM_WEBHOOK_SECRET"] = previous;
    }
  }
}

type SpaceRow = { phone_e164: string; channel_space_id: string | null };
async function spectrumSpaceFor(db: Queryable, userId: string) {
  const result = await db.query<SpaceRow>(
    "select phone_e164, channel_space_id from users where user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("spectrum_user_not_found");
  return { handle: row.phone_e164, spaceId: row.channel_space_id };
}

async function rememberSpectrumSpace(db: Queryable, userId: string, spaceId: string) {
  await db.query("update users set channel_space_id = $2 where user_id = $1", [userId, spaceId]);
}

export const defaultRuntimeFactories: RuntimeFactories = {
  async openDatabase(url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    return { db: pool, close: () => pool.end() };
  },
  async connectSpectrum(config) {
    const app = await Spectrum({
      projectId: config.projectId,
      projectSecret: config.projectSecret,
      providers: [imessage.config()],
    });
    return { spaces: imessage(app).space, stop: () => app.stop() };
  },
  createKeyProvider: createHandleEnvelopeKeyProvider,
  createSpectrumChannel({ port, db, webhookSecret }) {
    const channel = new SpectrumChannel({
      port,
      spaceFor: (userId) => spectrumSpaceFor(db, userId),
      rememberSpace: (userId, spaceId) => rememberSpectrumSpace(db, userId, spaceId),
    });
    return new WebhookSecretChannel(channel, webhookSecret);
  },
  listen: (app, options) => app.listen(options).then(() => undefined),
  closeApp: (app) => app.close(),
  log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
};

type Cleanup = () => Promise<void>;
async function closeAll(cleanups: readonly Cleanup[], primary?: unknown): Promise<void> {
  let first = primary;
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { first ??= error; }
  }
  if (first !== undefined) throw first;
}

async function boundedCheck(
  component: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
  log: RuntimeLog,
): Promise<ComponentState> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ComponentState>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  const checked = check()
    .then<ComponentState>((up) => up ? "up" : "down")
    .catch<ComponentState>(() => "down");
  const outcome = await Promise.race([checked, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome !== "up") log({ msg: "runtime.readiness_failed", component, outcome });
  return outcome;
}

export function createRuntimeStatus(input: {
  db: Queryable;
  channel: Channel;
  timeoutMs: number;
  isClosing: () => boolean;
  log: RuntimeLog;
}): RuntimeStatus {
  return {
    live: () => !input.isClosing(),
    async ready(): Promise<ReadinessSnapshot> {
      if (input.isClosing()) return { ready: false, components: { runtime: "down" } };
      const [database, spectrum] = await Promise.all([
        boundedCheck("database", input.timeoutMs, async () => {
          await input.db.query("select 1");
          return true;
        }, input.log),
        boundedCheck("spectrum", input.timeoutMs, async () =>
          (await input.channel.health()).status === "up", input.log),
      ]);
      return { ready: database === "up" && spectrum === "up", components: { database, spectrum } };
    },
  };
}

export type RunningRuntime = {
  app: FastifyInstance;
  capabilities: { handleEnvelopeKeys: HandleEnvelopeKeyProvider | null };
  status: RuntimeStatus;
  close(): Promise<void>;
};

export async function startRuntime(
  config: RuntimeConfig = loadRuntimeConfig(),
  overrides: Partial<RuntimeFactories> = {},
): Promise<RunningRuntime> {
  const factories = { ...defaultRuntimeFactories, ...overrides };
  const cleanups: Cleanup[] = [];
  let closing = false;
  let database: DatabaseResource;
  let spectrum: SpectrumResource | null = null;
  try {
    database = await factories.openDatabase(config.databaseUrl ?? LOCAL_DATABASE_URL);
    cleanups.unshift(() => database.close());

    let channel: Channel;
    let registrar: Registrar;
    if (config.spectrum !== null) {
      spectrum = await factories.connectSpectrum(config.spectrum);
      cleanups.unshift(() => spectrum!.stop());
      const port = new LiveSpectrumPort(spectrum.spaces);
      channel = factories.createSpectrumChannel({
        port,
        db: database.db,
        webhookSecret: config.spectrum.webhookSecret,
      });
      registrar = new SpectrumRegistrar(port, config.spectrum.lineE164);
    } else if (!config.production) {
      channel = new StubChannel();
      registrar = new StubRegistrar();
    } else throw new RuntimeConfigError(["SPECTRUM configuration"]);

    const handleEnvelopeKeys = config.contactKeyEnvelopeMasterKey === null
      ? null
      : factories.createKeyProvider(config.contactKeyEnvelopeMasterKey);
    const status = createRuntimeStatus({
      db: database.db,
      channel,
      timeoutMs: config.readinessTimeoutMs,
      isClosing: () => closing,
      log: factories.log,
    });
    if (!(await status.ready()).ready) throw new Error("runtime_dependencies_unready");

    const app = buildServer({ channel, registrar });
    registerHealthRoutes(app, status);
    cleanups.unshift(() => factories.closeApp(app));
    await factories.listen(app, { port: config.port, host: config.host });

    return {
      app,
      capabilities: { handleEnvelopeKeys },
      status,
      async close() {
        if (closing) return;
        closing = true;
        await closeAll(cleanups);
      },
    };
  } catch (error) {
    closing = true;
    await closeAll(cleanups, error);
    throw error;
  }
}

if (process.argv[1]?.endsWith("main.js") || process.argv[1]?.endsWith("main.ts")) {
  const runtime = await startRuntime();
  const shutdown = () => {
    void runtime.close().then(
      () => { process.exitCode = 0; },
      () => {
        process.stderr.write(`${JSON.stringify({ msg: "runtime.shutdown_failed" })}\n`);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
