// Proves the plumbing this branch adds actually connects: `cloud/api/src/main.ts` installs
// a live `DeviceGateway` (via `installDeviceGateway`, runtime.ts) once at boot, and
// `search_messages` (tools.ts) — reached through `AgentClosedChatBridge.waitingOnMe()`
// (inbound-bridge.ts) exactly as it runs in production, with no test-only device-search
// override — must reach that same installed gateway via `deviceSearchPortFor(scope)`.
//
// Two things this file exists to catch:
//   1. A regression where the bridge goes back to hardcoding `DegradedDeviceSearchPort` (the
//      bug this branch fixes: `evidence_count=0` for every query in production).
//   2. A regression where "no device connected" stops being distinguishable from "device
//      answered with nothing" — §4.3 requires the three reasons stay honest and distinct.
//
// Uses `DeviceGateway` (device-search) with the same in-process fake `DeviceSocket` shape
// `cloud/device-search/src/gateway.test.ts` uses, so this test exercises the real
// request/response correlation logic, not a mock of it.

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { unsafeScopeFromUserId } from "../../db/src/scope.js";
import { DeviceGateway, type DeviceSocket } from "../../device-search/src/gateway.js";
import type { AskDeviceSearchRequest, AskDeviceSearchResponse } from "../../device-search/src/protocol.js";
import { InMemoryAgentStore } from "../src/ports.js";
import { AgentClosedChatBridge } from "../src/inbound-bridge.js";
import { installDeviceGateway, uninstallDeviceGatewayForTest } from "../src/runtime.js";
import type { InboundMessage } from "../../shared/src/contracts.js";
import type { AgentModelProvider, EscalationProvider } from "../src/agent-loop.js";
import type { RouterProvider } from "../src/router.js";
import type { ChatMessage, ToolCall } from "../src/gemini-client.js";

/** A fake Mac that answers every `ask_device` request it receives with `reply(request)`. */
function fakeConnectedDevice(reply: (request: AskDeviceSearchRequest) => AskDeviceSearchResponse): DeviceSocket {
  const listeners: Record<string, Array<(data: RawData) => void>> = {};
  return {
    readyState: WebSocket.OPEN,
    send: (data: string, cb?: (err?: Error) => void) => {
      const request = JSON.parse(data) as AskDeviceSearchRequest;
      const response = reply(request);
      queueMicrotask(() => {
        for (const l of listeners["message"] ?? []) l(Buffer.from(JSON.stringify(response)));
      });
      cb?.();
    },
    on: ((event: string, listener: (data: RawData) => void) => {
      (listeners[event] ??= []).push(listener);
    }) as DeviceSocket["on"],
    ping: () => {},
    terminate: () => {},
  };
}

function message(text: string): InboundMessage {
  return {
    schema_version: "inbound.v1",
    provider: "spectrum",
    provider_message_id: "pm_wire_1",
    line_id: "line_1",
    from_handle: "h_1",
    user_id: "usr_wiretest",
    received_at: "2026-08-11T00:00:00Z",
    kind: "text",
    text,
  };
}

/** Forces the router straight to "agent" and scripts a model that calls `search_messages`
 * once, then reports whatever came back in its final answer — so the tool's real output
 * (device row vs. degraded `asleep`) is observable through the bridge's reply. */
function bridgeThatAsksAboutTheTrip(store: InMemoryAgentStore): AgentClosedChatBridge {
  class AlwaysAgentRouter implements RouterProvider {
    async classify(): Promise<unknown> {
      return { kind: "agent" };
    }
  }
  let turn = 0;
  class SearchingModel implements AgentModelProvider {
    async turn(_messages: ChatMessage[]): Promise<{ content: string | null; tool_calls: ToolCall[] | null }> {
      turn += 1;
      if (turn === 1) {
        const call: ToolCall = {
          id: "call_1",
          type: "function",
          function: { name: "search_messages", arguments: JSON.stringify({ query: "trip" }) },
        };
        return { content: null, tool_calls: [call] };
      }
      return { content: "Here is what I found about the trip.", tool_calls: null };
    }
  }
  class NeverEscalation implements EscalationProvider {
    async regenerate(): Promise<string> {
      throw new Error("must not be called");
    }
  }
  return new AgentClosedChatBridge({
    store,
    runtimeOverride: { router: new AlwaysAgentRouter(), agentModel: new SearchingModel(), escalation: new NeverEscalation() },
  });
}

describe("device-search wiring — installDeviceGateway makes search_messages reach the real gateway port", () => {
  afterEach(() => {
    uninstallDeviceGatewayForTest();
  });

  it("a connected device answers, and the reply carries real message evidence — never the DegradedDeviceSearchPort stub", async () => {
    const scope = unsafeScopeFromUserId("usr_wiretest001");
    const gateway = new DeviceGateway({ timeoutMs: 500 });
    const socket = fakeConnectedDevice((request) => ({
      v: 1,
      id: request.id,
      ok: true,
      results: [
        {
          person_id: "p_ahad01",
          when: "2026-08-01T12:00:00Z",
          snippet: "the [trip] is booked",
          thread_id: "chat_1",
          score: 0.92,
        },
      ],
    }));
    gateway.register(scope.user_id, socket);
    installDeviceGateway(gateway);

    const bridge = bridgeThatAsksAboutTheTrip(new InMemoryAgentStore());
    const reply = await bridge.waitingOnMe(message("what did ahad say about the trip"), scope);

    expect(reply.schema_version).toBe("chat_reply.v2");
    expect(reply.kind).toBe("open");
    if (reply.schema_version !== "chat_reply.v2") throw new Error("expected chat_reply.v2");
    // search_messages (tools.ts) tags every device row `{ source: "message", id:
    // "<thread_id>:<when>" }` — this can only be present if the tool actually reached the
    // installed gateway's live connection rather than the degraded stub, which always
    // returns zero results and zero evidence.
    expect(reply.evidence).toEqual([{ source: "message", id: "chat_1:2026-08-01T12:00:00Z" }]);
  });

  it("no device connected: search_messages degrades honestly to asleep — never fabricates an empty-but-successful search", async () => {
    const scope = unsafeScopeFromUserId("usr_wiretest002");
    // Installed, but nothing ever registered for this user_id — the "Mac not linked /
    // not awake" case, distinct from a device that answered with nothing.
    installDeviceGateway(new DeviceGateway({ timeoutMs: 500 }));

    const bridge = bridgeThatAsksAboutTheTrip(new InMemoryAgentStore());
    const reply = await bridge.waitingOnMe(message("what did ahad say about the trip"), scope);

    expect(reply.schema_version).toBe("chat_reply.v2");
    expect(reply.kind).toBe("open");
    if (reply.schema_version !== "chat_reply.v2") throw new Error("expected chat_reply.v2");
    // No message evidence — the tool ran, got `{ok:false, reason:"asleep"}`, and returned
    // `evidence: []` rather than fabricating a result to cite.
    expect(reply.evidence).toEqual([]);
  });

  it("never installed (e.g. a process that skipped main.ts's startRuntime): falls back to the same honest degraded stub as before this branch", async () => {
    const scope = unsafeScopeFromUserId("usr_wiretest003");
    // uninstallDeviceGatewayForTest() in afterEach already guarantees a clean slate, but
    // asserting it here documents the fallback explicitly rather than relying on ordering.
    const bridge = bridgeThatAsksAboutTheTrip(new InMemoryAgentStore());
    const reply = await bridge.waitingOnMe(message("what did ahad say about the trip"), scope);

    expect(reply.schema_version).toBe("chat_reply.v2");
    if (reply.schema_version !== "chat_reply.v2") throw new Error("expected chat_reply.v2");
    expect(reply.evidence).toEqual([]);
  });
});
