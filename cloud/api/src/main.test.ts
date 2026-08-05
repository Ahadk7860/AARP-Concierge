import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { StubChannel } from "../../shared/src/index.js";
import {
  closePool,
  getPool,
  isInstalledPool,
  type Queryable,
} from "../../db/src/index.js";
import { registerHealthRoutes } from "./health.js";
import { buildServer } from "./server.js";
import {
  RuntimeConfigError,
  createRuntimeStatus,
  loadRuntimeConfig,
  startRuntime,
  type RuntimeConfig,
  type RuntimeFactories,
} from "./main.js";

const productionEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgres://boi:secret@db.example/boi",
  CONTACT_KEY_ENVELOPE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  SPECTRUM_PROJECT_ID: "project",
  SPECTRUM_PROJECT_SECRET: "project-secret",
  SPECTRUM_LINE_E164: "+16465550123",
  SPECTRUM_WEBHOOK_SECRET: "webhook-secret",
  BOI_CARD_PRIVATE_BASE: "http://boi-card.railway.internal:8080",
  BOI_CARD_PUBLIC_BASE: "https://boi-api.example.com",
  BOI_CARD_WRITE_SECRET: "card-write-secret",
  READINESS_TIMEOUT_MS: "50",
};

const queryResult = { rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
function db(query: () => Promise<unknown> = async () => queryResult): Queryable {
  return { query: query as Queryable["query"] };
}

function fakePool(
  query: () => Promise<unknown> = async () => queryResult,
  end: () => Promise<void> = async () => {},
): Pool {
  return { query: query as Pool["query"], end } as unknown as Pool;
}

function productionConfig(): RuntimeConfig {
  return loadRuntimeConfig(productionEnv);
}

function testFactories(overrides: Partial<RuntimeFactories> = {}): Partial<RuntimeFactories> {
  return {
    openDatabase: async () => fakePool(),
    connectSpectrum: async () => ({ spaces: {} as never, stop: async () => {} }),
    createSpectrumChannel: () => new StubChannel(),
    listen: async () => {},
    closeApp: async (app) => { await app.close(); },
    fetch: async () => new Response(JSON.stringify({ status: "ready" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    log: () => {},
    ...overrides,
  };
}

afterEach(async () => {
  await closePool();
});

describe("runtime configuration", () => {
  it.each([
    "DATABASE_URL",
    "SPECTRUM_PROJECT_ID",
    "SPECTRUM_PROJECT_SECRET",
    "SPECTRUM_LINE_E164",
    "SPECTRUM_WEBHOOK_SECRET",
    "CONTACT_KEY_ENVELOPE_MASTER_KEY",
    "BOI_CARD_PRIVATE_BASE",
    "BOI_CARD_PUBLIC_BASE",
    "BOI_CARD_WRITE_SECRET",
  ])("fails closed when production omits %s", (name) => {
    const incomplete: NodeJS.ProcessEnv = { ...productionEnv };
    delete incomplete[name];
    expect(() => loadRuntimeConfig(incomplete)).toThrow(RuntimeConfigError);
    try { loadRuntimeConfig(incomplete); } catch (error) {
      expect(error).toMatchObject({ missing: expect.arrayContaining([name]) });
    }
  });

  it("parses production settings and fixes the public bind address", () => {
    expect(productionConfig()).toMatchObject({
      production: true,
      host: "0.0.0.0",
      port: 8080,
      databaseUrl: productionEnv.DATABASE_URL,
      readinessTimeoutMs: 50,
      spectrum: { lineE164: "+16465550123" },
      card: {
        privateBase: "http://boi-card.railway.internal:8080",
        publicBase: "https://boi-api.example.com",
      },
    });
  });

  it("refuses partial Spectrum configuration outside production", () => {
    expect(() => loadRuntimeConfig({ SPECTRUM_PROJECT_ID: "project" })).toThrow(
      /SPECTRUM_PROJECT_SECRET/,
    );
  });
});

describe("configuration propagation", () => {
  it("passes every validated deployment input to its consuming factory", async () => {
    const seen: Record<string, unknown> = {};
    const runtime = await startRuntime(productionConfig(), testFactories({
      openDatabase: async (url) => {
        seen["databaseUrl"] = url;
        return fakePool();
      },
      connectSpectrum: async (config) => {
        seen["spectrum"] = config;
        return { spaces: {} as never, stop: async () => {} };
      },
      createSpectrumChannel: ({ webhookSecret }) => {
        seen["webhookSecret"] = webhookSecret;
        return new StubChannel();
      },
      createKeyProvider: (key) => {
        seen["masterKey"] = Buffer.from(key);
        return { keyId: "test", key: () => Buffer.from(key) };
      },
    }));

    expect(seen).toMatchObject({
      databaseUrl: productionEnv.DATABASE_URL,
      spectrum: {
        projectId: "project",
        projectSecret: "project-secret",
        lineE164: "+16465550123",
        webhookSecret: "webhook-secret",
      },
      webhookSecret: "webhook-secret",
    });
    expect(seen["masterKey"]).toEqual(Buffer.alloc(32, 7));
    expect(runtime.capabilities.handleEnvelopeKeys?.key()).toEqual(Buffer.alloc(32, 7));
    await runtime.close();
  });

  it("installs one pool for repository traffic, readiness, and shutdown", async () => {
    const sql: string[] = [];
    let opened = 0;
    let ended = 0;
    const installed = fakePool(
      async (text?: unknown) => {
        sql.push(String(text));
        return queryResult;
      },
      async () => { ended += 1; },
    );
    const runtime = await startRuntime(productionConfig(), testFactories({
      openDatabase: async () => { opened += 1; return installed; },
    }));

    expect(getPool()).toBe(installed);
    expect(isInstalledPool(installed)).toBe(true);
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: { authorization: "Bearer usr_12345678.not-a-real-secret" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(sql.some((statement) => statement.includes("from devices"))).toBe(true);
    await runtime.status.ready();
    expect(sql.filter((statement) => statement === "select 1").length).toBeGreaterThanOrEqual(2);
    expect(opened).toBe(1);

    await runtime.close();
    expect(ended).toBe(1);
    expect(isInstalledPool(installed)).toBe(false);
  });
});

describe("startup and shutdown safety", () => {
  it("closes the database when Spectrum connection fails and preserves the connect error", async () => {
    const events: string[] = [];
    const connectError = new Error("connect failed");
    await expect(startRuntime(productionConfig(), testFactories({
      openDatabase: async () => fakePool(undefined, async () => { events.push("db.close"); }),
      connectSpectrum: async () => { throw connectError; },
    }))).rejects.toBe(connectError);
    expect(events).toEqual(["db.close"]);
  });

  it("closes app, Spectrum, and database after listen failure while preserving the listen error", async () => {
    const events: string[] = [];
    const listenError = new Error("listen failed");
    await expect(startRuntime(productionConfig(), testFactories({
      openDatabase: async () => fakePool(undefined, async () => { events.push("db.close"); }),
      connectSpectrum: async () => ({ spaces: {} as never, stop: async () => { events.push("spectrum.stop"); } }),
      listen: async () => { throw listenError; },
      closeApp: async (app) => {
        events.push("app.close");
        await app.close();
        throw new Error("secondary close failure");
      },
    }))).rejects.toBe(listenError);
    expect(events).toEqual(["app.close", "spectrum.stop", "db.close"]);
  });

  it("attempts every independent close and reports the first close failure", async () => {
    const events: string[] = [];
    const appCloseError = new Error("app close failed");
    const runtime = await startRuntime(productionConfig(), testFactories({
      openDatabase: async () => fakePool(undefined, async () => { events.push("db.close"); }),
      connectSpectrum: async () => ({
        spaces: {} as never,
        stop: async () => { events.push("spectrum.stop"); throw new Error("stop failed"); },
      }),
      closeApp: async (app) => {
        events.push("app.close");
        await app.close();
        throw appCloseError;
      },
    }));
    await expect(runtime.close()).rejects.toBe(appCloseError);
    expect(events).toEqual(["app.close", "spectrum.stop", "db.close"]);
  });

  it("withdraws readiness before resources begin closing", async () => {
    const runtime = await startRuntime(productionConfig(), testFactories());
    expect((await runtime.status.ready()).ready).toBe(true);
    await runtime.close();
    expect(await runtime.status.ready()).toEqual({ ready: false, components: { runtime: "down" } });
    expect(await runtime.status.live()).toBe(false);
  });
});

describe("bounded readiness", () => {
  it("includes private card readiness in the common dependency snapshot", async () => {
    const status = createRuntimeStatus({
      db: db(),
      channel: new StubChannel(),
      timeoutMs: 50,
      isClosing: () => false,
      log: () => {},
      dependencies: { card: async () => false },
    });
    expect(await status.ready()).toEqual({
      ready: false,
      components: { database: "up", spectrum: "up", card: "down" },
    });
  });

  it("returns the timed-out component slug and logs no configuration values", async () => {
    const events: Array<Record<string, unknown>> = [];
    const never = new Promise<unknown>(() => {});
    const status = createRuntimeStatus({
      db: db(() => never),
      channel: new StubChannel(),
      timeoutMs: 10,
      isClosing: () => false,
      log: (event) => { events.push(event); },
    });
    expect(await status.ready()).toEqual({
      ready: false,
      components: { database: "timeout", spectrum: "up" },
    });
    expect(events).toEqual([
      { msg: "runtime.readiness_failed", component: "database", outcome: "timeout" },
    ]);
  });

  it("exposes the injected component snapshot over HTTP", async () => {
    const app = buildServer();
    registerHealthRoutes(app, {
      live: () => true,
      ready: () => ({ ready: false, components: { database: "down", spectrum: "up" } }),
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "unready",
      components: { database: "down", spectrum: "up" },
    });
    await app.close();
  });
});
