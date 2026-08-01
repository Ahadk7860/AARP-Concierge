import { describe, it, expect } from "vitest";
import { StubChannel } from "./stub-channel.js";
import type { OutboundMessage } from "./contracts.js";

const msg: OutboundMessage = {
  schema_version: "outbound.v1",
  user_id: "usr_demo0001",
  idempotency_key: "t-1",
  blocks: [{ type: "text", text: "hello" }],
};

describe("foundation harness", () => {
  it("stub channel sends", async () => {
    const c = new StubChannel();
    const r = await c.send(msg);
    expect(r.protocol).toBe("imessage");
  });
  it("banned line throws rather than silently succeeding", async () => {
    const c = new StubChannel("banned");
    await expect(c.send(msg)).rejects.toThrow("line_banned");
  });
  it("bad signature is rejected", () => {
    const c = new StubChannel();
    expect(() => c.normalizeInbound({}, "nope")).toThrow("bad_signature");
  });
});
