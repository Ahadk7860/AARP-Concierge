// Adapters that wire the Spectrum stream into I's InboundRouter and J's ClosedChat port.
//
// Every adapter here is deliberately thin: it maps one existing interface to another
// without adding logic.

import type { SpectrumStreamEvent } from "../channel/src/spectrum-stream.js";
import type {
  InboundMessage,
  OutboundMessage,
  Channel,
} from "../shared/src/index.js";
import { createUser, findUserIdByHandle, type UserScope } from "../db/src/index.js";
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
// Event decoder for the Photon SDK (photon.codes) Message type.
//
// The payload from liveStreamPort is { space: Space, message: Message }.
// Content is a discriminated union; we extract text/reaction/typing from it.
// ---------------------------------------------------------------------------

interface PhotonPayload {
  space: { id: string; phone?: unknown };
  message: {
    id: string;
    direction: string;
    // The webhook path (spectrum-channel.ts:172) correctly reads sender["address"].
    // The SDK stream delivers Message objects where sender is a User{id, __platform}.
    // We have not yet verified a live SDK message — id MAY be the E.164 or may be a
    // Photon-internal identifier. Until confirmed, prefer address when available.
    sender?: { id: string; address?: string; __platform: string };
    timestamp: Date;
    content: { type: string; text?: string; emoji?: string; state?: string };
  };
}

export class SpectrumEventDecoder implements InboundEventDecoder {
  decode(event: SpectrumStreamEvent): InboundMessage {
    const payload = event.payload as PhotonPayload | null;
    const msg = payload?.message;
    const space = payload?.space;

    const content = msg?.content;
    let kind: InboundMessage["kind"] = "tapback";
    let text: string | null = null;

    if (content !== undefined) {
      if (content.type === "text") {
        kind = "text";
        const raw = content.text;
        text = typeof raw === "string" && raw.length > 0 ? raw : null;
      } else if (content.type === "reaction") {
        kind = "tapback";
        text = typeof content.emoji === "string" ? content.emoji : null;
      } else if (content.type === "typing") {
        kind = "typing";
      }
    }

    // The webhook path uses sender["address"], confirmed from Photon JSON payload.
    // The SDK stream delivers User{id} — id MAY be the E.164 but is UNVERIFIED.
    // Prefer address (webhook parity); fall back to id; throw only when neither exists.
    const fromHandle = msg?.sender?.address
      ?? msg?.sender?.id
      ?? (() => { throw new Error("spectrum_message_no_sender"); })();

    return {
      schema_version: "inbound.v1",
      provider: "spectrum",
      provider_message_id: event.id,
      line_id: space?.id ?? "",
      from_handle: fromHandle,
      user_id: null,
      received_at: (msg?.timestamp
        ? new Date(msg.timestamp).toISOString().replace(/\.\d{3}Z$/, "Z")
        : new Date().toISOString().replace(/\.\d{3}Z$/, "Z")),
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
    // Auto-setup welcome: when a new user texts boi-setup (or variants),
    // respond with a welcome instead of falling through to the chat selector.
    if (isSetupToken(text)) {
      return {
        kind: "handled",
        intent: "auto_setup",
        reply_text: "all set — i haven't read your messages yet. "
          + "open the Mac app, grant Full Disk Access, and i'll text you "
          + "when your history is ready. you can also ask me things like "
          + "\"who should i follow up with\" once your digest syncs.",
      };
    }
    return { kind: "unhandled" };
  }
}

function isSetupToken(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "boi-setup" || t.startsWith("boi-setup ");
}

// ---------------------------------------------------------------------------
// Closed chat port — delegates to J's runClosedChat with a digest.v2 lookup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auto-setup — creates a user on-the-fly when an unknown handle sends boi-setup.
// Skipping the web signup entirely: the phone number is the identity, and the
// setup token proves intent. On Photon Pro there is no allowlist to register.
// ---------------------------------------------------------------------------

export class AutoSetupUserCreator {
  constructor(private readonly db: Queryable) {}

  async createFromSetup(message: InboundMessage): Promise<UserScope | null> {
    const phone = message.from_handle;
    if (!phone || !/^\+[1-9][0-9]{6,14}$/.test(phone)) return null;
    try {
      const result = await createUser({ phone_e164: phone }, this.db);
      return result.scope;
    } catch {
      // If user already exists (race), resolve by handle instead.
      return findUserIdByHandle(phone, this.db);
    }
  }
}

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
