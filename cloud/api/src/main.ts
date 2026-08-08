// Production composition root. Every secret is parsed once, then passed explicitly to
// the dependency that consumes it. No production path can select a stub.

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Spectrum, type Space, type SpectrumInstance } from "@spectrum-ts/core";
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
import {
  closePool,
  installExternalCardStore,
  installPool,
  isInstalledPool,
  type Queryable,
} from "../../db/src/index.js";
import { SpectrumChannel } from "../../channel/src/spectrum-channel.js";
import { LiveSpectrumPort } from "../../channel/src/spectrum-live.js";
import { SpectrumRegistrar } from "../../channel/src/spectrum-registrar.js";
import {
  registerHealthRoutes,
  type ComponentState,
  type ReadinessSnapshot,
  type RuntimeStatus,
} from "./health.js";
import type { SpectrumStreamPort } from "../../channel/src/spectrum-stream.js";
import { buildServer } from "./server.js";
import type { ChatSelectorProvider } from "../../chat/src/selector.js";
import { enhanceRuntimeWithPhase2, type Phase2Config } from "../../phase2-runtime/compose-runtime.js";
import { stubStreamPort } from "../../phase2-runtime/stub-stream-port.js";
import { liveModelConfigFromEnv, ModelChatSelectorProvider } from "../../phase2-runtime/live-providers.js";
import { liveSpectrumStreamPort } from "../../phase2-runtime/live-stream-port.js";

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
  card: {
    privateBase: string;
    publicBase: string;
    writeSecret: string;
    proxyMaxBytes: number;
  } | null;
  readinessTimeoutMs: number;
  /** Phase 2 inbound stream + retention. Off by default until Photon is documented. */
  phase2: { enabled: boolean; user_id: string | null };
};

export type BoiProcess = "api" | "card";
export function processTargetFor(env: NodeJS.ProcessEnv = process.env): {
  name: BoiProcess;
  relativeFile: string;
} {
  const name = env["BOI_PROCESS"];
  if (name !== "api" && name !== "card") {
    throw new Error("BOI_PROCESS must be exactly 'api' or 'card'");
  }
  return { name, relativeFile: `dist/cloud/${name}/src/main.js` };
}

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
  const proxyMaxBytes = integerSetting(env, "BOI_CARD_PROXY_MAX_BYTES", 8 * 1024 * 1024, 1024, 32 * 1024 * 1024);
  invalid.push(...port.invalid, ...readinessTimeout.invalid, ...proxyMaxBytes.invalid);

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

  const cardPrivateBase = nonEmpty(env, "BOI_CARD_PRIVATE_BASE");
  const cardPublicBase = nonEmpty(env, "BOI_CARD_PUBLIC_BASE");
  const cardWriteSecret = nonEmpty(env, "BOI_CARD_WRITE_SECRET");
  const configuredCard = [cardPrivateBase, cardPublicBase, cardWriteSecret]
    .some((value) => value !== null);
  if (configuredCard || production) {
    for (const [name, value] of [
      ["BOI_CARD_PRIVATE_BASE", cardPrivateBase],
      ["BOI_CARD_PUBLIC_BASE", cardPublicBase],
      ["BOI_CARD_WRITE_SECRET", cardWriteSecret],
    ] as const) if (value === null) missing.push(name);
    for (const [name, value, protocol] of [
      ["BOI_CARD_PRIVATE_BASE", cardPrivateBase, "http:"],
      ["BOI_CARD_PUBLIC_BASE", cardPublicBase, production ? "https:" : null],
    ] as const) {
      if (value === null) continue;
      try {
        const parsed = new URL(value);
        if ((protocol !== null && parsed.protocol !== protocol)
            || parsed.username !== "" || parsed.password !== ""
            || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
          invalid.push(`${name} (must be an origin${protocol === null ? "" : ` using ${protocol}`})`);
        }
        if (production && name === "BOI_CARD_PRIVATE_BASE"
            && !parsed.hostname.endsWith(".railway.internal")) {
          invalid.push("BOI_CARD_PRIVATE_BASE (must use Railway private networking)");
        }
      } catch {
        invalid.push(`${name} (must be a URL origin)`);
      }
    }
  }
  if (missing.length > 0 || invalid.length > 0) throw new RuntimeConfigError(missing, invalid);


  const phase2Enabled = nonEmpty(env, "BOI_PHASE2_ENABLED") === "1";
  const phase2UserId = nonEmpty(env, "BOI_PHASE2_USER_ID") ?? null;
  return {
    production,
    host: "0.0.0.0",
    port: port.value,
    databaseUrl,
    contactKeyEnvelopeMasterKey,
    spectrum: configuredSpectrum && projectId && projectSecret && lineE164 && webhookSecret
      ? { projectId, projectSecret, lineE164, webhookSecret }
      : null,
    card: configuredCard && cardPrivateBase && cardPublicBase && cardWriteSecret
      ? {
        privateBase: cardPrivateBase.replace(/\/$/, ""),
        publicBase: cardPublicBase.replace(/\/$/, ""),
        writeSecret: cardWriteSecret,
        proxyMaxBytes: proxyMaxBytes.value,
      }
      : null,
    readinessTimeoutMs: readinessTimeout.value,
    phase2: { enabled: phase2Enabled, user_id: phase2UserId },
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
type SpectrumResource = { spaces: SpaceOps; stop(): Promise<void>; app?: SpectrumInstance };
type RuntimeLog = (event: { msg: string; component?: string; outcome?: string }) => void;

export type RuntimeFactories = {
  openDatabase(url: string): Promise<pg.Pool>;
  connectSpectrum(config: SpectrumConfig): Promise<SpectrumResource>;
  createKeyProvider(key: Buffer): HandleEnvelopeKeyProvider;
  createSpectrumChannel(input: {
    port: LiveSpectrumPort;
    db: Queryable;
    webhookSecret: string;
  }): Channel;
  listen(app: FastifyInstance, options: { host: string; port: number }): Promise<void>;
  closeApp(app: FastifyInstance): Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  log: RuntimeLog;
  createPhase2StreamPort?(): SpectrumStreamPort;
  createPhase2SelectorProvider?(): ChatSelectorProvider;
};

const LOCAL_DATABASE_URL = "postgres://localhost:5432/boi_dev_d";

class WebhookSecretChannel implements Channel {
  constructor(private readonly delegate: Channel, private readonly webhookSecret: string) {}
  send(message: OutboundMessage): Promise<SendResult> { return this.delegate.send(message); }
  capabilities(): Promise<Capabilities> { return this.delegate.capabilities(); }
  health(): Promise<ChannelHealth> { return this.delegate.health(); }
  normalizeInbound(rawBody: Buffer | string, signature: string, timestamp?: string): InboundMessage {
    const previous = process.env["SPECTRUM_WEBHOOK_SECRET"];
    process.env["SPECTRUM_WEBHOOK_SECRET"] = this.webhookSecret;
    try {
      return (this.delegate as SpectrumChannel).normalizeInbound(rawBody, signature, timestamp);
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
    return new pg.Pool({ connectionString: url, max: 8 });
  },
  async connectSpectrum(config) {
    const app = await Spectrum({
      projectId: config.projectId,
      projectSecret: config.projectSecret,
      providers: [imessage.config()],
    });
    return { spaces: imessage(app).space, stop: () => app.stop(), app };
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
  fetch: (input, init) => fetch(input, init),
  log: (event) => process.stdout.write(`${JSON.stringify(event)}
`),
  /** Stub until Photon SDK is documented. Replace before production. */
  createPhase2StreamPort: () => stubStreamPort(),
  createPhase2SelectorProvider: (): ChatSelectorProvider => {
    // When env is configured, use live model directly from here so that
    // the production path activates without compose-runtime wiring changes.
    const config = liveModelConfigFromEnv();
    if (config) return new ModelChatSelectorProvider(config);
    return { select: async () => ({ kind: "decline" as const }) };
  },
};
const CARD_PATH = /^\/cards\/usr_[0-9A-Za-z]{8,32}\/card_[0-9a-f]{16}\.png$/;
const CARD_SIGNATURE = /^[0-9a-f]{64}$/;
const PUBLIC_CARD_CACHE_CONTROL = "private, max-age=300";

function validSignedCardUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl, "http://proxy.invalid"); } catch { return null; }
  if (!CARD_PATH.test(parsed.pathname)) return null;
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 2 || keys[0] !== "exp" || keys[1] !== "sig") return null;
  const exp = parsed.searchParams.get("exp");
  const sig = parsed.searchParams.get("sig");
  if (exp === null || !/^[1-9][0-9]{0,12}$/.test(exp) || sig === null || !CARD_SIGNATURE.test(sig)) {
    return null;
  }
  return parsed;
}

async function boundedResponseBody(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

export function registerCardProxy(
  app: FastifyInstance,
  card: NonNullable<RuntimeConfig["card"]>,
  request: RuntimeFactories["fetch"] = defaultRuntimeFactories.fetch,
): void {
  app.route({
    method: "GET",
    url: "/cards/*",
    exposeHeadRoute: false,
    async handler(req, reply) {
      const parsed = validSignedCardUrl(req.raw.url ?? "");
      if (parsed === null) return reply.code(400).send({ error: "invalid_card_url" });
      let upstream: Response;
      try {
        upstream = await request(`${card.privateBase}${parsed.pathname}${parsed.search}`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
          headers: { accept: "image/png" },
        });
      } catch {
        return reply.code(502).send({ error: "bad_gateway" });
      }
      if (upstream.status === 401) return reply.code(401).send({ error: "unauthorized" });
      if (upstream.status === 404) return reply.code(404).send({ error: "not_found" });
      if (upstream.status !== 200 || upstream.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
        return reply.code(502).send({ error: "bad_gateway" });
      }
      const declared = upstream.headers.get("content-length");
      if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > card.proxyMaxBytes)) {
        return reply.code(413).send({ error: "card_too_large" });
      }
      const body = await boundedResponseBody(upstream, card.proxyMaxBytes);
      if (body === null) return reply.code(413).send({ error: "card_too_large" });
      return reply.code(200)
        .header("content-type", "image/png")
        .header("cache-control", PUBLIC_CARD_CACHE_CONTROL)
        .header("content-location", `${card.publicBase}${parsed.pathname}${parsed.search}`)
        .send(body);
    },
  });
}

export async function checkPrivateCardReadiness(
  card: NonNullable<RuntimeConfig["card"]>,
  request: RuntimeFactories["fetch"],
): Promise<boolean> {
  const response = await request(`${card.privateBase}/readyz`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  if (response.status !== 200) return false;
  const body = await boundedResponseBody(response, 256);
  return body !== null && (JSON.parse(body.toString("utf8")) as { status?: unknown }).status === "ready";
}

export function createPrivateCardStore(
  card: NonNullable<RuntimeConfig["card"]>,
  request: RuntimeFactories["fetch"],
): { name: string; deleteAndCount(userId: string): Promise<number> } {
  return {
    name: "cards(private)",
    async deleteAndCount(userId) {
      const response = await request(`${card.privateBase}/internal/cards/${userId}`, {
        method: "DELETE",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "x-boi-card-write": card.writeSecret, accept: "application/json" },
      });
      if (response.status !== 200) throw new Error("private card deletion failed");
      const body = await boundedResponseBody(response, 256);
      if (body === null) throw new Error("private card deletion response too large");
      const payload = JSON.parse(body.toString("utf8")) as { remaining?: unknown };
      if (!Number.isSafeInteger(payload.remaining) || Number(payload.remaining) < 0) {
        throw new Error("private card deletion returned invalid residue");
      }
      return Number(payload.remaining);
    },
  };
}

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
  dependencies?: Record<string, () => Promise<boolean>>;
}): RuntimeStatus {
  return {
    live: () => !input.isClosing(),
    async ready(): Promise<ReadinessSnapshot> {
      if (input.isClosing()) return { ready: false, components: { runtime: "down" } };
      const checks: Record<string, () => Promise<boolean>> = {
        database: async () => {
          await input.db.query("select 1");
          return true;
        },
        spectrum: async () => (await input.channel.health()).status === "up",
        ...input.dependencies,
      };
      const entries = await Promise.all(Object.entries(checks).map(async ([component, check]) =>
        [component, await boundedCheck(component, input.timeoutMs, check, input.log)] as const));
      const components = Object.fromEntries(entries);
      return { ready: entries.every(([, state]) => state === "up"), components };
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
  let database: pg.Pool;
  let spectrum: SpectrumResource | null = null;
  try {
    database = await factories.openDatabase(config.databaseUrl ?? LOCAL_DATABASE_URL);
    // Register cleanup before installation: if another live pool is already installed,
    // installPool throws and this newly-created resource still has to be closed.
    cleanups.unshift(async () => {
      if (isInstalledPool(database)) await closePool();
      else await database.end();
    });
    installPool(database);

    if (config.card !== null) {
      const restoreCardStore = installExternalCardStore(createPrivateCardStore(config.card, factories.fetch));
      cleanups.unshift(async () => { restoreCardStore(); });
    }

    let channel: Channel;
    let registrar: Registrar;
    if (config.spectrum !== null) {
      spectrum = await factories.connectSpectrum(config.spectrum);
      cleanups.unshift(() => spectrum!.stop());
      const port = new LiveSpectrumPort(spectrum.spaces);
      channel = factories.createSpectrumChannel({
        port,
        db: database,
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

    // Phase 2 inbound stream + retention (K-02). Off by default until Photon is verified.
    let phase2: Awaited<ReturnType<typeof enhanceRuntimeWithPhase2>> = null;
    if (config.phase2.enabled && config.phase2.user_id !== null && handleEnvelopeKeys !== null
        && factories.createPhase2StreamPort && factories.createPhase2SelectorProvider) {
      const streamPort = spectrum?.app !== undefined
        ? liveSpectrumStreamPort(spectrum.app)
        : factories.createPhase2StreamPort();
      const selector = factories.createPhase2SelectorProvider();
      phase2 = await enhanceRuntimeWithPhase2(
        { enabled: true, user_id: config.phase2.user_id },
        {
          db: database,
          streamPort,
          channel,
          keyProvider: handleEnvelopeKeys,
          selectorProvider: selector,
        },
      );
      if (phase2 !== null) {
        cleanups.unshift(() => phase2!.close());
      }
    }

    const phase2Ready = phase2 === null ? null : () => phase2.readinessCheck();
    const statusDeps = { ...(config.card === null ? {} : {
      card: () => checkPrivateCardReadiness(config.card!, factories.fetch),
    })} as Record<string, () => Promise<boolean>>;
    if (phase2Ready !== null) statusDeps.phase2 = phase2Ready;

    const status = createRuntimeStatus({
      db: database,
      channel,
      timeoutMs: config.readinessTimeoutMs,
      isClosing: () => closing,
      log: factories.log,
      dependencies: statusDeps,
    });
    if (!(await status.ready()).ready) throw new Error("runtime_dependencies_unready");

    const app = buildServer({ channel, registrar });
    if (config.card !== null) registerCardProxy(app, config.card, factories.fetch);
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
