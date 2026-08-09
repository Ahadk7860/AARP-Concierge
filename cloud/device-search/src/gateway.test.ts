import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { unsafeScopeFromUserId } from "../../db/src/scope.js";
import { DeviceGateway, attachDeviceGateway } from "./gateway.js";
import type { AskDeviceSearchRequest, AskDeviceSearchResponse } from "./protocol.js";

/** A fake Mac: replies to every request it receives with a canned response. */
function fakeMac(reply: (request: AskDeviceSearchRequest) => AskDeviceSearchResponse | null) {
  return (data: string): string | null => {
    const request = JSON.parse(data) as AskDeviceSearchRequest;
    const response = reply(request);
    return response === null ? null : JSON.stringify(response);
  };
}

describe("DeviceGateway — in-process socket pair (unit level)", () => {
  it("returns asleep immediately when no Mac is connected, without waiting the timeout", async () => {
    const gateway = new DeviceGateway({ timeoutMs: 5_000 });
    const start = Date.now();
    const response = await gateway.search("usr_offline00", {
      v: 1,
      id: "req_1",
      op: "search",
      query: "trip",
      limit: 5,
    });
    const elapsed = Date.now() - start;
    expect(response).toEqual({ v: 1, id: "req_1", ok: false, reason: "asleep" });
    expect(elapsed).toBeLessThan(200); // must not be waiting out the 5s timeout
  });

  it("hasConnection reflects registration state", () => {
    const gateway = new DeviceGateway();
    expect(gateway.hasConnection("usr_x")).toBe(false);
  });
});

describe("DeviceGateway — real WebSocket round trip", () => {
  async function withServer(
    run: (args: { server: Server; gateway: DeviceGateway; url: string }) => Promise<void>,
  ): Promise<void> {
    const server = createServer();
    const gateway = new DeviceGateway({ timeoutMs: 300 });
    attachDeviceGateway(server, gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = `ws://127.0.0.1:${address.port}/v1/device-link`;
    try {
      await run({ server, gateway, url });
    } finally {
      server.close();
    }
  }

  it("round-trips a real search request/response over an actual socket", async () => {
    await withServer(async ({ gateway, url }) => {
      const mac = new WebSocket(`${url}?user_id=usr_realmac01`);
      await new Promise<void>((resolve, reject) => {
        mac.on("open", () => resolve());
        mac.on("error", reject);
      });

      const respond = fakeMac((request) => ({
        v: 1,
        id: request.id,
        ok: true,
        results: [
          {
            person_id: "+15550001111",
            when: "2026-01-01T00:00:00Z",
            snippet: "the [trip] is on",
            thread_id: "chat_1",
            score: 0.87,
          },
        ],
      }));
      mac.on("message", (data) => {
        const reply = respond(data.toString());
        if (reply !== null) mac.send(reply);
      });

      // give the server a tick to finish the upgrade -> register() handshake
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gateway.hasConnection("usr_realmac01")).toBe(true);

      const response = await gateway.search("usr_realmac01", {
        v: 1,
        id: "req_42",
        op: "search",
        query: "trip",
        limit: 5,
      });

      expect(response).toEqual({
        v: 1,
        id: "req_42",
        ok: true,
        results: [
          {
            person_id: "+15550001111",
            when: "2026-01-01T00:00:00Z",
            snippet: "the [trip] is on",
            thread_id: "chat_1",
            score: 0.87,
          },
        ],
      });

      mac.close();
    });
  });

  it("passes through the Mac's own no_grant response unchanged", async () => {
    await withServer(async ({ gateway, url }) => {
      const mac = new WebSocket(`${url}?user_id=usr_nogrant01`);
      await new Promise<void>((resolve) => mac.on("open", () => resolve()));
      mac.on("message", (data) => {
        const request = JSON.parse(data.toString()) as AskDeviceSearchRequest;
        mac.send(JSON.stringify({ v: 1, id: request.id, ok: false, reason: "no_grant" }));
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const response = await gateway.search("usr_nogrant01", {
        v: 1,
        id: "req_ng",
        op: "search",
        query: "trip",
        limit: 5,
      });
      expect(response).toEqual({ v: 1, id: "req_ng", ok: false, reason: "no_grant" });
      mac.close();
    });
  });

  it("times out distinguishably from asleep when the Mac never answers", async () => {
    await withServer(async ({ gateway, url }) => {
      const mac = new WebSocket(`${url}?user_id=usr_silent01`);
      await new Promise<void>((resolve) => mac.on("open", () => resolve()));
      // never replies
      await new Promise((resolve) => setTimeout(resolve, 20));

      const start = Date.now();
      const response = await gateway.search("usr_silent01", {
        v: 1,
        id: "req_to",
        op: "search",
        query: "trip",
        limit: 5,
      });
      const elapsed = Date.now() - start;
      expect(response).toEqual({ v: 1, id: "req_to", ok: false, reason: "timeout" });
      expect(elapsed).toBeGreaterThanOrEqual(290); // waited out the (test) 300ms budget
      mac.close();
    });
  });

  it("a reconnect replaces the previous socket rather than accumulating connections", async () => {
    await withServer(async ({ gateway, url }) => {
      const first = new WebSocket(`${url}?user_id=usr_reconnect01`);
      await new Promise<void>((resolve) => first.on("open", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gateway.hasConnection("usr_reconnect01")).toBe(true);

      const firstClosed = new Promise<void>((resolve) => first.on("close", () => resolve()));

      const second = new WebSocket(`${url}?user_id=usr_reconnect01`);
      await new Promise<void>((resolve) => second.on("open", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 20));

      await firstClosed; // the gateway terminated it on the new registration
      expect(gateway.hasConnection("usr_reconnect01")).toBe(true);
      second.close();
    });
  });

  it("rejects a connection with no resolvable user_id", async () => {
    await withServer(async ({ url }) => {
      const anon = new WebSocket(url); // no ?user_id=
      const outcome = await new Promise<"open" | "closed">((resolve) => {
        anon.on("open", () => resolve("open"));
        anon.on("close", () => resolve("closed"));
        anon.on("error", () => resolve("closed"));
      });
      expect(outcome).toBe("closed");
    });
  });

  it("portFor() binds a DeviceSearchPort to exactly the request's scope's user_id", async () => {
    await withServer(async ({ gateway, url }) => {
      const mac = new WebSocket(`${url}?user_id=usr_scoped001`);
      await new Promise<void>((resolve) => mac.on("open", () => resolve()));
      mac.on("message", (data) => {
        const request = JSON.parse(data.toString()) as AskDeviceSearchRequest;
        mac.send(JSON.stringify({ v: 1, id: request.id, ok: true, results: [] }));
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const port = gateway.portFor(unsafeScopeFromUserId("usr_scoped001"));
      const response = await port.search({
        v: 1,
        id: "req_scoped",
        op: "search",
        query: "trip",
        limit: 5,
      });
      expect(response.ok).toBe(true);
      mac.close();
    });
  });
});
