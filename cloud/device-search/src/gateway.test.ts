import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import {
  acquireSuiteLock,
  closePool,
  createUser,
  deleteUser,
  getPool,
  migrate,
  newDeviceId,
  registerDevice,
  releaseSuiteLock,
  unsafeScopeFromUserId,
  type UserScope,
} from "../../db/src/index.js";
import {
  DeviceGateway,
  attachDeviceGateway,
  authenticateDeviceLinkRequest,
  insecureDevUserIdFromQueryParam,
  type DeviceSocket,
} from "./gateway.js";
import type { AskDeviceSearchRequest, AskDeviceSearchResponse } from "./protocol.js";

/** A fake Mac: replies to every request it receives with a canned response. */
function fakeMac(reply: (request: AskDeviceSearchRequest) => AskDeviceSearchResponse | null) {
  return (data: string): string | null => {
    const request = JSON.parse(data) as AskDeviceSearchRequest;
    const response = reply(request);
    return response === null ? null : JSON.stringify(response);
  };
}

/** A minimal `DeviceSocket`-shaped fake with full control over ping/pong, so the
 * heartbeat can be exercised without a real dead TCP connection (which `ws` answers
 * automatically at the protocol level, making it untestable from here). */
function fakeDeviceSocket(options: { respondToPing?: boolean } = {}): {
  socket: DeviceSocket;
  isTerminated: () => boolean;
} {
  const listeners: Record<string, Array<() => void>> = {};
  let readyState: number = WebSocket.OPEN;
  let terminated = false;
  const socket: DeviceSocket = {
    get readyState() {
      return readyState;
    },
    send: (_data: string, cb?: (err?: Error) => void) => cb?.(),
    on: ((event: string, listener: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(listener as () => void);
    }) as DeviceSocket["on"],
    ping: () => {
      if (options.respondToPing ?? true) {
        for (const l of listeners["pong"] ?? []) l();
      }
    },
    terminate: () => {
      terminated = true;
      readyState = WebSocket.CLOSED;
      for (const l of listeners["close"] ?? []) l();
    },
  };
  return { socket, isTerminated: () => terminated };
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

  it("heartbeat keeps a connection that answers pings marked live", async () => {
    const gateway = new DeviceGateway({ heartbeatMs: 20 });
    const { socket, isTerminated } = fakeDeviceSocket({ respondToPing: true });
    gateway.register("usr_alive001", socket);
    await new Promise((resolve) => setTimeout(resolve, 90)); // several heartbeat ticks
    expect(isTerminated()).toBe(false);
    expect(gateway.hasConnection("usr_alive001")).toBe(true);
  });

  it("heartbeat terminates a socket that never answers a ping, so hasConnection stops lying", async () => {
    const gateway = new DeviceGateway({ heartbeatMs: 20 });
    const { socket, isTerminated } = fakeDeviceSocket({ respondToPing: false });
    gateway.register("usr_stale001", socket);
    // First tick sends a ping (isAlive stays true for it); the *next* tick finds no
    // pong arrived and terminates. Two ticks plus slack is enough.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(isTerminated()).toBe(true);
    expect(gateway.hasConnection("usr_stale001")).toBe(false);
  });
});

describe("DeviceGateway — real WebSocket round trip", () => {
  async function withServer(
    run: (args: { server: Server; gateway: DeviceGateway; url: string }) => Promise<void>,
    gatewayOptions: ConstructorParameters<typeof DeviceGateway>[0] = { timeoutMs: 300 },
  ): Promise<void> {
    const server = createServer();
    const gateway = new DeviceGateway(gatewayOptions);
    // Explicit opt-in: these tests exercise the transport/correlation logic, not auth,
    // so they name the insecure dev resolver themselves rather than relying on any
    // default doing it for them.
    attachDeviceGateway(server, gateway, { resolveUserId: insecureDevUserIdFromQueryParam });
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

// ---------------------------------------------------------------------------
// Real device-token auth against a live `boi_dev_d` — the actual security fix. One
// database-touching file per track, serialised against `cloud/db/src/schema.test.ts`
// and `cloud/api/src/ingest.test.ts` via the same advisory lock (see
// `cloud/db/src/test-lock.ts`), since vitest runs test FILES in parallel.
// ---------------------------------------------------------------------------
describe("authenticateDeviceLinkRequest — real device tokens", () => {
  const pool = getPool();
  const createdScopes: UserScope[] = [];

  // Random, not a counter: this file has no schema-dropping beforeAll of its own (that
  // lives in cloud/db/src/schema.test.ts), so a deterministic phone number would collide
  // with a row a previous `vitest run` left behind — same reason every other
  // DB-touching test file in this repo (signup.test.ts, pipeline.test.ts,
  // bridge.test.ts, scheduler.test.ts, turns.test.ts) randomises its phone numbers.
  function randomPhone(): string {
    return `+1559${String(Math.floor(Math.random() * 9_000_000 + 1_000_000))}`;
  }

  async function newAccount(): Promise<{ userId: string; token: string }> {
    const { scope } = await createUser({ phone_e164: randomPhone() });
    createdScopes.push(scope);
    const { device_token } = await registerDevice(scope, {
      device_id: newDeviceId(),
      platform: "test",
    });
    return { userId: scope.user_id, token: device_token };
  }

  function fakeUpgradeRequest(url: string, headers: Record<string, string> = {}) {
    return { url, headers } as unknown as import("node:http").IncomingMessage;
  }

  beforeAll(async () => {
    await acquireSuiteLock();
    await migrate(pool);
  }, 120_000);

  afterAll(async () => {
    for (const scope of createdScopes) {
      await deleteUser(scope);
    }
    await closePool();
    await releaseSuiteLock();
  });

  it("accepts a valid device token whose claimed user_id matches the token's own user", async () => {
    const account = await newAccount();
    const req = fakeUpgradeRequest(`/v1/device-link?user_id=${account.userId}`, {
      authorization: `Bearer ${account.token}`,
    });
    await expect(authenticateDeviceLinkRequest(req)).resolves.toBe(account.userId);
  });

  it("rejects when the Authorization header is missing entirely", async () => {
    const account = await newAccount();
    const req = fakeUpgradeRequest(`/v1/device-link?user_id=${account.userId}`);
    await expect(authenticateDeviceLinkRequest(req)).resolves.toBeNull();
  });

  it("rejects a malformed / forged token", async () => {
    const account = await newAccount();
    const req = fakeUpgradeRequest(`/v1/device-link?user_id=${account.userId}`, {
      authorization: "Bearer garbage",
    });
    await expect(authenticateDeviceLinkRequest(req)).resolves.toBeNull();

    const forged = fakeUpgradeRequest(`/v1/device-link?user_id=${account.userId}`, {
      authorization: `Bearer ${account.userId}.not-the-real-secret`,
    });
    await expect(authenticateDeviceLinkRequest(forged)).resolves.toBeNull();
  });

  it("rejects a token for user A claiming to be user B (cross-user IDOR)", async () => {
    const userA = await newAccount();
    const userB = await newAccount();
    const req = fakeUpgradeRequest(`/v1/device-link?user_id=${userB.userId}`, {
      authorization: `Bearer ${userA.token}`, // A's real token, claiming B
    });
    await expect(authenticateDeviceLinkRequest(req)).resolves.toBeNull();
  });

  it("rejects when no user_id is claimed at all, even with a valid token", async () => {
    const account = await newAccount();
    const req = fakeUpgradeRequest("/v1/device-link", {
      authorization: `Bearer ${account.token}`,
    });
    await expect(authenticateDeviceLinkRequest(req)).resolves.toBeNull();
  });

  it("end to end: the real default resolver rejects an upgrade with no token, and accepts one with a valid token", async () => {
    const account = await newAccount();
    const server = createServer();
    const gateway = new DeviceGateway();
    attachDeviceGateway(server, gateway); // no override: exercises the real default
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = `ws://127.0.0.1:${address.port}/v1/device-link`;

    try {
      // No auth at all -> rejected.
      const anon = new WebSocket(`${url}?user_id=${account.userId}`);
      const anonOutcome = await new Promise<"open" | "closed">((resolve) => {
        anon.on("open", () => resolve("open"));
        anon.on("close", () => resolve("closed"));
        anon.on("error", () => resolve("closed"));
      });
      expect(anonOutcome).toBe("closed");
      expect(gateway.hasConnection(account.userId)).toBe(false);

      // Valid bearer token -> accepted.
      const authed = new WebSocket(`${url}?user_id=${account.userId}`, {
        headers: { authorization: `Bearer ${account.token}` },
      });
      await new Promise<void>((resolve, reject) => {
        authed.on("open", () => resolve());
        authed.on("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gateway.hasConnection(account.userId)).toBe(true);
      authed.close();
    } finally {
      server.close();
    }
  });
});
