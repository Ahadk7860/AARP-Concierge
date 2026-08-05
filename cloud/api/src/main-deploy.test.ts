import { describe, expect, it } from "vitest";

import { loadCardRuntimeConfig, startCardRuntime } from "../../card/src/main.js";
import { processTargetFor } from "./main.js";

describe("Railway process selection", () => {
  it.each(["api", "card"] as const)("selects the compiled %s entrypoint", (name) => {
    expect(processTargetFor({ BOI_PROCESS: name })).toEqual({
      name,
      relativeFile: `dist/cloud/${name}/src/main.js`,
    });
  });

  it("fails closed instead of starting an accidental default process", () => {
    expect(() => processTargetFor({})).toThrow(/BOI_PROCESS/);
    expect(() => processTargetFor({ BOI_PROCESS: "worker" })).toThrow(/BOI_PROCESS/);
  });
});

describe("hosted card production configuration", () => {
  const complete = {
    NODE_ENV: "production",
    PORT: "8080",
    BOI_CARD_DIR: "/data/cards",
    BOI_CARD_SIGNING_SECRET: "signing-secret",
    BOI_CARD_WRITE_SECRET: "write-secret",
    BOI_CARD_PUBLIC_BASE: "https://cards.example.com",
    RAILWAY_VOLUME_MOUNT_PATH: "/data/cards",
  };

  it("binds Railway's public interface and consumes the persistent volume path", () => {
    expect(loadCardRuntimeConfig(complete)).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      cardDir: "/data/cards",
      publicBase: "https://cards.example.com",
      volumeMountPath: "/data/cards",
    });
  });

  it("publishes a health route on Railway's assigned host and port", async () => {
    const config = loadCardRuntimeConfig(complete);
    let bound: { host: string; port: number } | undefined;
    let prepared: string | undefined;
    const runtime = await startCardRuntime(config, {
      listen: async (_app, input) => { bound = input; },
      prepareStorage: async (directory) => { prepared = directory; },
    });
    expect(bound).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(prepared).toBe("/data/cards");
    const health = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    await runtime.close();
  });

  it.each([
    "PORT",
    "BOI_CARD_DIR",
    "BOI_CARD_SIGNING_SECRET",
    "BOI_CARD_WRITE_SECRET",
    "BOI_CARD_PUBLIC_BASE",
    "RAILWAY_VOLUME_MOUNT_PATH",
  ])("fails closed when production omits %s", (name) => {
    const env: NodeJS.ProcessEnv = { ...complete };
    delete env[name];
    expect(() => loadCardRuntimeConfig(env)).toThrow(new RegExp(name));
  });
});
