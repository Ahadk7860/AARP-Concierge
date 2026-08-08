import { createHash } from "node:crypto";

import type { SpectrumStreamEvent } from "../channel/src/spectrum-stream.js";
import type { ChatReply, InboundMessage } from "../shared/src/contracts.js";
import type { UserScope } from "../db/src/scope.js";
import { EncryptedPrivateStore } from "./private-store.js";

export type DeterministicIntentResult =
  | { kind: "handled"; intent: string; reply_text: string | null }
  | { kind: "unhandled" };

/** Adapter to the existing deterministic inbound intent handler. It must only decide. */
export interface DeterministicIntentPort {
  route(message: InboundMessage, scope: UserScope): Promise<DeterministicIntentResult>;
}

/** Track J implements this closed seam; Track I neither imports nor widens J's code. */
export interface ClosedChatPort {
  waitingOnMe(message: InboundMessage, scope: UserScope): Promise<ChatReply>;
}

export interface InboundEventDecoder {
  decode(event: SpectrumStreamEvent): InboundMessage;
}

export interface InboundUserResolver {
  resolve(message: InboundMessage): Promise<UserScope | null>;
}

/** Delivery must dedupe by `idempotency_key`; retries intentionally reuse it. */
export interface InboundReplyDeliveryPort {
  deliver(input: { scope: UserScope; text: string; idempotency_key: string }): Promise<void>;
}

export type InboundRouteOutcome =
  | { kind: "ignored"; reason: "non_text" | "empty_text" }
  | { kind: "unknown_user" }
  | { kind: "duplicate"; idempotency_key: string }
  | { kind: "deterministic"; intent: string; reply_text: string | null; idempotency_key: string }
  | { kind: "chat"; reply: ChatReply; idempotency_key: string };

export const SETUP_TOKEN = "boi-setup";

export interface SetupUserCreator {
  createFromSetup(message: InboundMessage): Promise<UserScope | null>;
}

export type InboundRouterOptions = {
  decoder: InboundEventDecoder;
  users: InboundUserResolver;
  deterministic: DeterministicIntentPort;
  chat: ClosedChatPort;
  delivery: InboundReplyDeliveryPort;
  privateStore: EncryptedPrivateStore;
  setupUser?: SetupUserCreator | undefined;
  now?: () => Date;
};

/**
 * The side-effect boundary installed as `SpectrumStream.onEvent`.
 *
 * Decision ports run before persistence and must be side-effect free. The encrypted
 * inbound/outbound pair is then claimed atomically before an idempotent delivery call.
 * A redelivery retries that call with the same key: neither a lost first attempt nor two
 * successful sends can result if the delivery adapter honors its required contract.
 */
export class InboundRouter {
  constructor(private readonly options: InboundRouterOptions) {}

  async route(event: SpectrumStreamEvent): Promise<InboundRouteOutcome> {
    const message = this.options.decoder.decode(event);
    if (message.kind !== "text") return { kind: "ignored", reason: "non_text" };
    if (message.text === null || message.text.length === 0) return { kind: "ignored", reason: "empty_text" };
    let scope = await this.options.users.resolve(message);
    if (scope === null) {
      const isSetup = parseSetupToken(message.text);
      if (!isSetup || this.options.setupUser === undefined) return { kind: "unknown_user" };
      scope = await this.options.setupUser.createFromSetup(message);
      if (scope === null) return { kind: "unknown_user" };
    }

    const occurredAt = strictDate(message.received_at);
    const key = idempotencyKey(message.provider, message.provider_message_id);
    const deliveryKey = idempotencyKey("delivery", key);
    const inboundTurnId = `turn_in_${key}`;
    const existing = await this.options.privateStore.canonicalOutcomeFor(scope, key);
    if (existing !== null) {
      await this.deliverCanonical(scope, existing);
      return { kind: "duplicate", idempotency_key: existing.delivery_key };
    }

    const deterministic = await this.options.deterministic.route(message, scope);
    const decided = deterministic.kind === "handled"
      ? { kind: "deterministic" as const, intent: deterministic.intent, reply_text: deterministic.reply_text }
      : { kind: "chat" as const, reply: await this.options.chat.waitingOnMe(message, scope) };
    const replyText = decided.kind === "deterministic" ? decided.reply_text : decided.reply.text;
    const outbound = replyText === null ? null : {
      turn_id: `turn_out_${key}`,
      text: replyText,
      occurred_at: this.now(),
    };

    const claimed = await this.options.privateStore.claimCanonicalOutcome({
      scope,
      event_key: key,
      delivery_key: deliveryKey,
      inbound: { turn_id: inboundTurnId, text: message.text, occurred_at: occurredAt },
      outbound,
    });
    // Always deliver the value read back from durable state. In a concurrent claim this
    // can differ from our computation; only the winner's encrypted canonical text ships.
    await this.deliverCanonical(scope, claimed.outcome);
    if (!claimed.claimed) return { kind: "duplicate", idempotency_key: claimed.outcome.delivery_key };
    return decided.kind === "deterministic"
      ? { ...decided, idempotency_key: claimed.outcome.delivery_key }
      : { ...decided, idempotency_key: claimed.outcome.delivery_key };
  }

  private async deliverCanonical(
    scope: UserScope,
    outcome: { event_key: string; delivery_key: string; delivery_status: "pending" | "sent" | "no_reply"; outbound_text: string | null },
  ): Promise<void> {
    if (outcome.delivery_status !== "pending") return;
    if (outcome.outbound_text === null) throw new Error("encrypted_outbox_corrupt");
    await this.options.delivery.deliver({
      scope,
      text: outcome.outbound_text,
      idempotency_key: outcome.delivery_key,
    });
    await this.options.privateStore.markOutcomeDelivered(scope, outcome.event_key, outcome.delivery_key);
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!Number.isFinite(value.getTime())) throw new Error("inbound_route_clock_invalid");
    return value;
  }
}

function parseSetupToken(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim().toLowerCase();
  return trimmed === SETUP_TOKEN || trimmed.startsWith(`${SETUP_TOKEN} `) || trimmed.endsWith(` ${SETUP_TOKEN}`)
    || trimmed.includes(` ${SETUP_TOKEN} `);
}

function idempotencyKey(provider: string, providerMessageId: string): string {
  return createHash("sha256").update(`${provider}\0${providerMessageId}`, "utf8").digest("hex").slice(0, 32);
}

function strictDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u.exec(value);
  if (match === null) {
    throw new Error("inbound_received_at_invalid");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(match[1]) ||
      date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3]) ||
      date.getUTCHours() !== Number(match[4]) || date.getUTCMinutes() !== Number(match[5]) ||
      date.getUTCSeconds() !== Number(match[6])) {
    throw new Error("inbound_received_at_invalid");
  }
  return date;
}
