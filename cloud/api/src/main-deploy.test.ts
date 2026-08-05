import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadCardRuntimeConfig,
  probeCardStorage,
  shouldStartCardProcess,
  startCardRuntime,
} from "../../card/src/main.js";
import { countCardsFor, putCard } from "../../card/src/store.js";
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
      storageReady: async () => true,
    });
    expect(bound).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(prepared).toBe("/data/cards");
    const health = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    const ready = await runtime.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
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

  it("supports vite-node's npm lifecycle entrypoint and CARD_PORT without double-selection", () => {
    const meta = pathToFileURL("/tmp/card-main.ts").href;
    expect(shouldStartCardProcess(meta, ["node", "/tmp/vite-node.mjs"], { npm_lifecycle_event: "card" })).toBe(true);
    expect(shouldStartCardProcess(meta, ["node", "/tmp/card-main.ts"], { npm_lifecycle_event: "card" })).toBe(true);
    expect(shouldStartCardProcess(meta, ["node", "/tmp/vite-node.mjs"], { CARD_PORT: "3043" })).toBe(true);
    expect(shouldStartCardProcess(meta, ["node", "/tmp/vite-node.mjs"], {})).toBe(false);
    expect(loadCardRuntimeConfig({ CARD_PORT: "3043" }).port).toBe(3043);
  });

  it("probes persistent storage with a private create/read/delete cycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boi-card-ready-"));
    try {
      await expect(probeCardStorage(directory)).resolves.toBe(true);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps readiness closed when the volume probe fails", async () => {
    const runtime = await startCardRuntime(loadCardRuntimeConfig(complete), {
      listen: async () => {},
      prepareStorage: async () => {},
      storageReady: async () => false,
    });
    const ready = await runtime.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unready" });
    await runtime.close();
  });

  it("authenticates internal deletion and verifies zero card residue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boi-card-delete-"));
    const config = loadCardRuntimeConfig({
      ...complete,
      BOI_CARD_DIR: directory,
      RAILWAY_VOLUME_MOUNT_PATH: directory,
    });
    const runtime = await startCardRuntime(config, { listen: async () => {} });
    try {
      putCard("usr_12345678", Buffer.from("png"));
      expect(countCardsFor("usr_12345678")).toBe(1);
      expect((await runtime.app.inject({
        method: "DELETE",
        url: "/internal/cards/usr_12345678",
      })).statusCode).toBe(401);
      const deleted = await runtime.app.inject({
        method: "DELETE",
        url: "/internal/cards/usr_12345678",
        headers: { "x-boi-card-write": "write-secret" },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ remaining: 0 });
      expect(countCardsFor("usr_12345678")).toBe(0);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails internal deletion when the post-delete verification finds residue", async () => {
    const runtime = await startCardRuntime(loadCardRuntimeConfig(complete), {
      listen: async () => {},
      prepareStorage: async () => {},
      deleteCards: () => 1,
      countCards: () => 1,
    });
    const response = await runtime.app.inject({
      method: "DELETE",
      url: "/internal/cards/usr_12345678",
      headers: { "x-boi-card-write": "write-secret" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "residue" });
    await runtime.close();
  });
});
