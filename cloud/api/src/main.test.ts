import { describe, expect, it } from "vitest";

import { registerHealthRoutes } from "./health.js";
import { buildServer } from "./server.js";
import { RuntimeConfigError, loadRuntimeConfig, startRuntime } from "./main.js";

const production = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgres://boi:secret@db.example/boi",
  CONTACT_KEY_ENVELOPE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  SPECTRUM_PROJECT_ID: "project",
  SPECTRUM_PROJECT_SECRET: "secret",
  SPECTRUM_LINE_E164: "+16465550123",
  SPECTRUM_WEBHOOK_SECRET: "webhook-secret",
};

describe("runtime configuration", () => {
  it("fails closed in production when a mandatory deployment secret is absent", () => {
    const { DATABASE_URL: _ignored, ...withoutDatabase } = production;
    expect(() => loadRuntimeConfig(withoutDatabase)).toThrow(RuntimeConfigError);
    try {
      loadRuntimeConfig(withoutDatabase);
    } catch (error) {
      expect(error).toMatchObject({ missing: ["DATABASE_URL"] });
    }
  });

  it("parses the production environment into a fixed public bind address", () => {
    expect(loadRuntimeConfig(production)).toMatchObject({
      production: true,
      host: "0.0.0.0",
      port: 8080,
      databaseUrl: production.DATABASE_URL,
      spectrum: { lineE164: "+16465550123" },
    });
  });

  it("refuses a partial Spectrum configuration even outside production", () => {
    expect(() => loadRuntimeConfig({ SPECTRUM_PROJECT_ID: "project" })).toThrow(
      /SPECTRUM_PROJECT_SECRET/,
    );
  });
});

describe("runtime health routes", () => {
  it("returns readiness from the injected status rather than assuming a stub is live", async () => {
    const app = buildServer();
    registerHealthRoutes(app, { live: () => true, ready: () => false });
    const live = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unready" });
    await app.close();
  });

  it("closes injected resources and withdraws readiness during shutdown", async () => {
    let closed = 0;
    const runtime = await startRuntime(
      { production: false, host: "0.0.0.0", port: 0, databaseUrl: null, contactKeyEnvelopeMasterKey: null, spectrum: null },
      {
        db: { query: async () => ({ rows: [], command: "SELECT", rowCount: 1, oid: 0, fields: [] }) },
        closeDb: async () => { closed += 1; },
      },
    );
    expect((await runtime.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await runtime.close();
    expect(closed).toBe(1);
  });
});
