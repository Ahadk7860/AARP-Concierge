// The cloud-side half of the persistent WebSocket link to a user's Mac (§4.3, owner:
// Track C). Nothing in this repo built the transport before this file — Tracks E/F/G
// build the data layer and delivery; the Mac <-> cloud link for `ask_device` is this
// track's to build, per V3_ARCHITECTURE.md §4.3's "Cloud -> Mac over the persistent
// WebSocket".
//
// Two concerns kept apart on purpose:
//   - `DeviceGateway` — the connection registry + request/response correlation. Takes
//     any `ws`-shaped socket, so it is unit-testable with a bare `ws` client/server
//     pair rather than a full Fastify app.
//   - `attachDeviceGateway` — the HTTP upgrade wiring that turns a real inbound
//     connection into a call to `gateway.register()`. This is the only piece that
//     needs an `http.Server`, and it is the piece `cloud/api/src/main.ts` (a shared
//     file) needs to call once, at startup.

import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { UserScope } from "../../db/src/scope.js";
import {
  isAskDeviceSearchResponse,
  type AskDeviceSearchRequest,
  type AskDeviceSearchResponse,
  type DeviceSearchPort,
} from "./protocol.js";

/** V3_ARCHITECTURE.md §4.3: "Timeout 4s -> agent degrades honestly from there." */
export const ASK_DEVICE_DEFAULT_TIMEOUT_MS = 4_000;

type PendingRequest = {
  resolve: (response: AskDeviceSearchResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The minimal surface `DeviceGateway` needs from a socket — satisfied by a real `ws`
 * WebSocket and by the fake used in tests, so the gateway's correlation logic can be
 * exercised without spinning up a network connection every time. */
export interface DeviceSocket {
  readonly readyState: number;
  send(data: string, callback?: (err?: Error) => void): void;
  on(event: "message", listener: (data: RawData) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  terminate(): void;
}

/**
 * Holds the live cloud <-> Mac connections and turns one `ask_device` request into one
 * response, correlated by `id`.
 *
 * §4.3 requires three *distinguishable* failure reasons, and this class is where that
 * distinction is actually made — Track B's agent branches on which one came back:
 *
 *   - no live connection for the user at all  -> `{ok:false, reason:"asleep"}`,
 *     resolved immediately, never waiting out the timeout for a Mac that plainly isn't
 *     there.
 *   - a live connection exists but does not answer inside the budget ->
 *     `{ok:false, reason:"timeout"}`.
 *   - `"no_grant"` is never produced here — it is the Mac's own honest answer (no
 *     search consent), which arrives as an ordinary `ok:false` message like any other
 *     response and is passed through unchanged.
 *
 * One live connection per user: a reconnect (`register` called again for the same
 * `userId`) replaces and terminates the previous socket rather than accumulating
 * zombies that would otherwise both receive requests.
 */
export class DeviceGateway {
  private readonly connections = new Map<string, DeviceSocket>();
  private readonly pending = new Map<string, PendingRequest>();
  readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? ASK_DEVICE_DEFAULT_TIMEOUT_MS;
  }

  register(userId: string, socket: DeviceSocket): void {
    const existing = this.connections.get(userId);
    if (existing !== undefined && existing !== socket) {
      existing.terminate();
    }
    this.connections.set(userId, socket);

    const drop = (): void => {
      if (this.connections.get(userId) === socket) this.connections.delete(userId);
    };
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", drop);
    socket.on("error", drop);
  }

  unregister(userId: string, socket?: DeviceSocket): void {
    if (socket === undefined || this.connections.get(userId) === socket) {
      this.connections.delete(userId);
    }
  }

  hasConnection(userId: string): boolean {
    const socket = this.connections.get(userId);
    return socket !== undefined && socket.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // malformed frame off the wire; nothing this layer can correlate
    }
    if (!isAskDeviceSearchResponse(parsed)) return;
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) return; // late, duplicate, or an id we never asked for
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    pending.resolve(parsed);
  }

  /** Sends one `ask_device` "search" request to `userId`'s Mac. Never fabricates a
   * result — every path resolves to a real Mac response or one of §4.3's three honest
   * failure reasons. */
  async search(userId: string, request: AskDeviceSearchRequest): Promise<AskDeviceSearchResponse> {
    const socket = this.connections.get(userId);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return { v: 1, id: request.id, ok: false, reason: "asleep" };
    }

    return new Promise<AskDeviceSearchResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve({ v: 1, id: request.id, ok: false, reason: "timeout" });
      }, this.timeoutMs);
      this.pending.set(request.id, { resolve, timer });

      socket.send(JSON.stringify(request), (err) => {
        if (err === undefined || err === null) return;
        const stillPending = this.pending.get(request.id);
        if (stillPending === undefined) return; // already resolved (e.g. raced the timeout)
        clearTimeout(stillPending.timer);
        this.pending.delete(request.id);
        resolve({ v: 1, id: request.id, ok: false, reason: "asleep" });
      });
    });
  }

  /**
   * A `DeviceSearchPort` bound to one user — the shape `ToolContext.deviceSearch`
   * wants (§4.2/§4.3). Construct one per turn; it holds no state of its own beyond the
   * scope, so making a fresh one per request is intentional and cheap.
   */
  portFor(scope: UserScope): DeviceSearchPort {
    const gateway = this;
    return {
      search(request: AskDeviceSearchRequest): Promise<AskDeviceSearchResponse> {
        return gateway.search(scope.user_id, request);
      },
    };
  }
}

/**
 * Attaches the WS upgrade handler to an existing HTTP server (Fastify exposes its raw
 * `http.Server` as `app.server`) so Macs can open the persistent connection this
 * protocol depends on.
 *
 * `resolveUserId` is the auth hook. **The default here reads `?user_id=` off the
 * connection URL and is a local/dev placeholder, not production auth** — a Mac could
 * claim to be anyone. Production wiring must swap in a real device-token check (the
 * same kind `bootstrapLookups.authenticateDeviceToken` does for HTTP requests
 * elsewhere in this repo). Logged as an open integration point in INTERFACES.md rather
 * than guessed at here, since the real device-token flow lives in `cloud/db` /
 * `cloud/api`, outside this track's files.
 */
export function attachDeviceGateway(
  server: HttpServer,
  gateway: DeviceGateway,
  options: {
    path?: string;
    resolveUserId?: (req: IncomingMessage) => string | null;
  } = {},
): WebSocketServer {
  const path = options.path ?? "/v1/device-link";
  const resolveUserId = options.resolveUserId ?? defaultResolveUserId;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname !== path) return; // not this gateway's path; leave for others
    const userId = resolveUserId(req);
    if (userId === null) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      gateway.register(userId, ws);
    });
  });

  return wss;
}

function defaultResolveUserId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://internal");
  const userId = url.searchParams.get("user_id");
  return userId !== null && userId.length > 0 ? userId : null;
}
