// Adapters that wire the Spectrum stream into I's InboundRouter and J's ClosedChat port.
//
// Every adapter here is deliberately thin: it maps one existing interface to another
// without adding logic. The event decoder is intentionally minimal until the Photon SDK
// is documented (per guardrail: "do not guess Photon cursor/SDK shapes").

import type { SpectrumStreamEvent } from "../channel/src/spectrum-stream.js";
import type {
  InboundMessage,
  OutboundMessage,
  Channel,
} from "../shared/src/index.js";
import { findUserIdByHandle, type UserScope } from "../db/src/index.js";
import type { Queryable } from "../db/src/pool.js";
import { latestDigest } from "../db/src/repository.js";
import { runClosedChat } from "../chat/src/pipeline.js";
import type {
  InboundEventDecoder, InboundUserResolver, InboundReplyDeliveryPort,
  DeterministicIntentPort, DeterministicIntentResult, ClosedChatPort,
} from "../inbound/router.js";
import type { ChatReply } from "../shared/src/contracts.js";
import type { ChatSelectorProvider } from "../chat/src/selector.js";

// ---------------------------------------------------------------------------
// Event decoder — intentionally minimal until Photon SDK is documented.
// ---------------------------------------------------------------------------

export class SpectrumEventDecoder implements InboundEventDecoder {
  decode(event: SpectrumStreamEvent): InboundMessage {
    const payload = event.payload as Record<string, unknown> | null;
    const from = typeof payload?.from === "string" ? payload.from : "";
    const text = typeof payload?.text === "string" ? payload.text : null;
    const kind: InboundMessage["kind"] =
      typeof text === "string" && text.length > 0 ? "text" : "tapback";
    return {
      schema_version: "inbound.v1",
      provider: "spectrum",
      provider_message_id: event.id,
      line_id: typeof payload?.line_id === "string" ? payload.line_id : "",
      from_handle: from,
      user_id: null,
      received_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      kind,
      text,
    };
  }
}

// ---------------------------------------------------------------------------
// User resolver — delegates to the existing handle-to-user lookup.
// ---------------------------------------------------------------------------

export class HandleUserResolver implements InboundUserResolver {
  constructor(private readonly db: Queryable) {}

  async resolve(message: InboundMessage): Promise<UserScope | null> {
    return findUserIdByHandle(message.from_handle, this.db);
  }
}

// ---------------------------------------------------------------------------
// Delivery port — sends via the existing Spectrum channel.
// ---------------------------------------------------------------------------

export class SpectrumReplyDeliveryPort implements InboundReplyDeliveryPort {
  constructor(private readonly channel: Channel) {}

  async deliver(input: { scope: UserScope; text: string; idempotency_key: string }): Promise<void> {
    const message: OutboundMessage = {
      schema_version: "outbound.v1",
      user_id: input.scope.user_id,
      idempotency_key: input.idempotency_key,
      blocks: [{ type: "text", text: input.text }],
      reply_to_message_id: null,
    };
    await this.channel.send(message);
  }
}

// ---------------------------------------------------------------------------
// Deterministic intent — strictly decides. Never sends.
// ---------------------------------------------------------------------------

export class DeterministicIntentAdapter implements DeterministicIntentPort {
  async route(message: InboundMessage, _scope: UserScope): Promise<DeterministicIntentResult> {
    const text = message.text ?? "";
    const pairingCode = /^\s*([0-9]{6})\s*[.!]?\s*$/.exec(text);
    if (pairingCode !== null) {
      return { kind: "handled", intent: "pairing_code", reply_text: null };
    }
    return { kind: "unhandled" };
  }
}

// ---------------------------------------------------------------------------
// Closed chat port — delegates to J's runClosedChat with a digest.v2 lookup.
// ---------------------------------------------------------------------------

export class ClosedChatAdapter implements ClosedChatPort {
  constructor(
    private readonly db: Queryable,
    private readonly selectorProvider: ChatSelectorProvider,
  ) {}

  async waitingOnMe(message: InboundMessage, scope: UserScope): Promise<ChatReply> {
    const digestRow = await latestDigest(scope, this.db);
    if (digestRow === null) {
      return {
        schema_version: "chat_reply.v1",
        kind: "decline",
        text: "I don't have a recent digest to answer from. Try again after your next sync.",
        synced_through: new Date().toISOString(),
        licenses: [],
      };
    }
    const payload = digestRow.payload as Record<string, unknown>;
    if (payload.schema_version !== "digest.v2") {
      const syncedThrough = (payload as { synced_through?: string }).synced_through
        ?? new Date().toISOString();
      return {
        schema_version: "chat_reply.v1",
        kind: "decline",
        text: "I don't have enough context to answer that yet. Sync from your Mac and try again.",
        synced_through: syncedThrough,
        licenses: [],
      };
    }
    const question = message.text ?? "";
    if (question.length === 0) {
      const syncedThrough = (payload as { synced_through: string }).synced_through;
      return {
        schema_version: "chat_reply.v1",
        kind: "decline",
        text: "I saw your message but I didn't catch a question. Could you try again?",
        synced_through: syncedThrough,
        licenses: [],
      };
    }
    const outcome = await runClosedChat(question, payload as never, this.selectorProvider);
    return outcome as ChatReply;
  }
}
