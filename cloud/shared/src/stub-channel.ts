// Foundation-owned stub. Lets Track D reach a green Definition of Done without
// Track C's real adapter existing. Track C replaces the real thing behind the same
// interface; nobody imports this in production code paths.

import type {
  Channel, OutboundMessage, SendResult, Capabilities, ChannelHealth, InboundMessage,
} from "./contracts.js";

export type StubMode = "up" | "degraded" | "banned";

export class StubChannel implements Channel {
  readonly sent: OutboundMessage[] = [];
  constructor(private mode: StubMode = "up", private lineId = "line_stub_1") {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.mode === "banned") {
      const e: Error & { code?: string } = new Error("line_banned");
      e.code = "line_banned";
      throw e;
    }
    this.sent.push(msg);
    return {
      message_id: `omsg_stub_${this.sent.length}`,
      provider: "mock",
      protocol: this.mode === "degraded" ? "sms" : "imessage",
      line_id: this.lineId,
    };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      tapbacks: true, images: true, groups: false, typing: true,
      richlinks: true, contact_cards: true, threading: true,
    };
  }

  async health(): Promise<ChannelHealth> {
    return { status: this.mode, line_id: this.lineId, checked_at: new Date().toISOString() };
  }

  normalizeInbound(rawBody: unknown, signature: string): InboundMessage {
    if (signature !== "stub-signature") throw new Error("bad_signature");
    const b = rawBody as Record<string, unknown>;
    return {
      schema_version: "inbound.v1",
      provider: "mock",
      provider_message_id: String(b.id ?? "mmsg_stub"),
      line_id: this.lineId,
      from_handle: String(b.from ?? "+15551234567"),
      user_id: null,
      received_at: new Date().toISOString(),
      kind: "text",
      text: typeof b.text === "string" ? b.text : null,
      reply_to_message_id: null,
      protocol: "imessage",
      trace_id: null,
    };
  }
}
