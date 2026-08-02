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
    expect(() => c.normalizeInbound("{}", "nope")).toThrow("bad_signature");
  });
  it("raw bytes are required — a parsed object is refused", () => {
    const c = new StubChannel();
    // @ts-expect-error the frozen interface takes Buffer | string, not an object
    expect(() => c.normalizeInbound({ id: "x" }, "stub-signature")).toThrow("raw_body_required");
  });
  it("accepts a Buffer, like a real webhook", () => {
    const c = new StubChannel();
    const m = c.normalizeInbound(Buffer.from('{"id":"m1","text":"2"}'), "stub-signature");
    expect(m.text).toBe("2");
    expect(m.provider_message_id).toBe("m1");
  });
});
