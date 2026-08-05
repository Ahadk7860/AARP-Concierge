import { afterEach, describe, expect, it } from "vitest";

import {
  deleteExternalCards,
  installExternalCardStore,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import {
  checkPrivateCardReadiness,
  createPrivateCardStore,
  registerCardProxy,
  type RuntimeConfig,
  type RuntimeFactories,
} from "./main.js";

const card: NonNullable<RuntimeConfig["card"]> = {
  privateBase: "http://boi-card.railway.internal:8080",
  publicBase: "https://boi-api.example.com",
  writeSecret: "write-secret",
  proxyMaxBytes: 16,
};
const signedPath = "/cards/usr_12345678/card_0123456789abcdef.png?exp=2000000000&sig="
  + "a".repeat(64);
const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("private card public proxy", () => {
  it("forwards only a bounded signed GET and emits only controlled response headers", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const request: RuntimeFactories["fetch"] = async (url, init) => {
      seen.push({ url, init });
      return new Response(Buffer.from("png"), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
          "set-cookie": "must-not-pass=1",
        },
      });
    };
    const app = buildServer();
    registerCardProxy(app, card, request);
    const response = await app.inject({ method: "GET", url: signedPath });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from("png"));
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers["content-location"]).toBe(`https://boi-api.example.com${signedPath}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: `http://boi-card.railway.internal:8080${signedPath}`,
      init: { method: "GET", redirect: "manual" },
    });
    await app.close();
  });

  it("never exposes HEAD, render, internal, malformed, duplicate, or oversized requests", async () => {
    let calls = 0;
    const request: RuntimeFactories["fetch"] = async () => {
      calls += 1;
      return new Response(Buffer.alloc(17), { status: 200, headers: { "content-type": "image/png" } });
    };
    const app = buildServer();
    registerCardProxy(app, card, request);
    expect((await app.inject({ method: "HEAD", url: signedPath })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/render" })).statusCode).not.toBe(200);
    expect((await app.inject({ method: "GET", url: "/internal/cards/usr_12345678" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${signedPath}&sig=${"b".repeat(64)}` })).statusCode).toBe(400);
    expect(calls).toBe(0);
    expect((await app.inject({ method: "GET", url: signedPath })).statusCode).toBe(413);
    await app.close();
  });

  it.each([
    [401, "application/json", 401],
    [404, "application/json", 404],
    [302, "text/html", 502],
    [200, "text/html", 502],
  ])("normalizes upstream status %s and content type", async (status, contentType, expected) => {
    const app = buildServer();
    registerCardProxy(app, card, async () => new Response("x", {
      status,
      headers: { "content-type": contentType },
    }));
    expect((await app.inject({ method: "GET", url: signedPath })).statusCode).toBe(expected);
    await app.close();
  });
});

describe("private card deletion adapter", () => {
  async function run(response: RuntimeFactories["fetch"]): Promise<string> {
    restores.push(installExternalCardStore(createPrivateCardStore(card, response)));
    return deleteExternalCards("usr_12345678");
  }

  it("authenticates deletion and accepts only verified zero residue", async () => {
    let seen: { url?: string; secret?: string; method?: string } = {};
    await expect(run(async (url, init) => {
      seen = {
        url,
        secret: new Headers(init?.headers).get("x-boi-card-write") ?? undefined,
        method: init?.method,
      };
      return new Response('{"remaining":0}', { status: 200 });
    })).resolves.toBe("cards(private)");
    expect(seen).toEqual({
      url: "http://boi-card.railway.internal:8080/internal/cards/usr_12345678",
      secret: "write-secret",
      method: "DELETE",
    });
  });

  it.each([
    ["nonzero residue", async () => new Response('{"remaining":1}', { status: 200 })],
    ["unreachable service", async () => { throw new Error("unreachable"); }],
    ["malformed response", async () => new Response('{"remaining":"zero"}', { status: 200 })],
    ["oversized chunked response", async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"remaining":'));
        controller.enqueue(new Uint8Array(300));
        controller.close();
      },
    }), { status: 200 })],
  ])("fails closed for %s", async (_name, request) => {
    await expect(run(request)).rejects.toThrow();
  });
});

describe("private card readiness response bounds", () => {
  it("accepts the bounded ready response", async () => {
    await expect(checkPrivateCardReadiness(
      card,
      async () => new Response('{"status":"ready"}', { status: 200 }),
    )).resolves.toBe(true);
  });

  it("rejects an oversized chunked response before parsing it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"ready","padding":"'));
        controller.enqueue(new Uint8Array(300));
        controller.close();
      },
    });
    await expect(checkPrivateCardReadiness(
      card,
      async () => new Response(body, { status: 200 }),
    )).resolves.toBe(false);
  });
});
