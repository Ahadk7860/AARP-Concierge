// `SpectrumChannel` — Photon behind the frozen `Channel` interface.
//
// Nothing above `cloud/channel/` learns the word Photon. That is not tidiness: it is the
// property the whole swap depends on, and Track C's Linq adapter is the evidence it holds
// for more than one implementation — which is why `cloud/mock-linq/` stays until this is
// green.
//
// Four methods, and three of the four decisions in them were made by the prompt:
//
//   1. **Verify the HMAC here, synchronously.** `app.webhook()` is async and
//      `normalizeInbound` is frozen and is not. See `spectrum-signature.ts`.
//   2. **`capabilities()` comes from config, not from probing.** The plan tier is a
//      sales-call answer, and `CONTRACTS.md` § 11 requires those to land in config.
//   3. **`"unknown"` does not become `"sms"`.** It becomes `null` — see `SendResult`.

import type {
  Capabilities,
  Channel,
  ChannelHealth,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "../../shared/src/index.js";
import type { SpectrumPart, SpectrumPort, SpectrumService, SpectrumSpaceRef } from "./spectrum-port.js";
import { verifySignature } from "./spectrum-signature.js";

/**
 * Photon's four services against Boi's three protocols, plus `null`.
 *
 * The whole reason this is a named function rather than a ternary: `unknown` is a real
 * answer from the provider, and the tempting collapse to `"sms"` would drive the
 * handle-mismatch flag — telling a user their number is not registered to iMessage on the
 * strength of a value that says we do not know.
 */
export function protocolFor(service: SpectrumService): SendResult["protocol"] {
  switch (service) {
    case "iMessage": return "imessage";
    case "SMS": return "sms";
    case "RCS": return "rcs";
    case "unknown": return null;
  }
}

/** The card is generated and its URL carries a signature, not an extension. */
const CARD_MIME = "image/png";

export type SpectrumChannelOptions = {
  port: SpectrumPort;
  /**
   * The user whose conversation this channel sends into, and the space id already known
   * for them. `outbound.v1` carries a `user_id` and no recipient — there is structurally
   * nowhere to put a handle — so the mapping from user to conversation lives here.
   */
  spaceFor: (userId: string) => Promise<{ handle: string; spaceId: string | null }>;
  /** Persist the space id the first time it is resolved. */
  rememberSpace?: (userId: string, spaceId: string) => Promise<void>;
  /**
   * Drop a stored space that the transport has refused.
   *
   * A space id encodes the handle it was created against. When the recipient's handle is
   * corrected, a space created against the old one keeps re-targeting it forever, and no
   * amount of fixing `phone_e164` helps. Forgetting on a permanent rejection is what lets
   * the next send create a fresh space against the current handle.
   */
  forgetSpace?: (userId: string) => Promise<void>;
  /** Free tier: groups are not available. Config, never probed. */
  groups?: boolean;
  /** 5,000 sends a day on the Free plan. */
  dailyQuota?: number;
  log?: (event: Record<string, unknown>) => void;
};

export const FREE_DAILY_QUOTA = 5_000;
/** Degraded at four fifths, so an operator hears about it with a day's warning. */
export const DEGRADED_AT = 0.8;
/** `Target not allowed for this project` twice running is a configuration fact, not luck. */
export const BAN_AFTER_REJECTIONS = 2;

export class SpectrumChannel implements Channel {
  private sentToday = 0;
  private rejections = 0;
  private lastLine: string | null = null;

  constructor(private readonly options: SpectrumChannelOptions) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const log = this.options.log ?? (() => {});
    const { handle, spaceId } = await this.options.spaceFor(msg.user_id);

    // `get` when we have an id, `create` when we do not. The prompt asked for this to
    // protect the new-conversation quota; the probe showed `space.create` is local and
    // consumes none, so the reason is now STABILITY — a tier that returns opaque ids must
    // not silently re-key a conversation the user can see.
    const space: SpectrumSpaceRef = spaceId === null
      ? await this.options.port.createSpace(handle)
      : await this.options.port.getSpace(spaceId);
    const parts = blocksToParts(msg);
    const result = await this.options.port.send(space, parts).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // The allowlist rejection, named. It is the one failure that means "this account
      // was never registered" rather than "the transport is having a bad minute", and
      // treating it as transient would retry forever against a permanent no.
      if (message.includes("Target not allowed for this project")) {
        this.rejections += 1;
        log({ msg: "spectrum.target_not_allowed", user_id: msg.user_id, rejections: this.rejections });
        // A refused space is not a space. Keeping it turns a corrected handle into a
        // permanently unreachable user: the stored id re-targets the old handle on every
        // later send, and the correction can never take effect.
        if (this.options.forgetSpace !== undefined) {
          await this.options.forgetSpace(msg.user_id);
        }
      }
      throw err;
    });

    // PERSIST ONLY WHAT WAS DELIVERED.
    //
    // This ran BEFORE the send and stored the space id unconditionally, so a first send
    // that failed left a durable space bound to a handle that never accepted it. That is
    // exactly how a seeded placeholder number outlived its own correction in production:
    // `users.phone_e164` was fixed, `users.channel_space_id` still read
    // `any;-;+15550009998`, and every reply was refused with nothing sent to the user.
    if (spaceId === null && this.options.rememberSpace !== undefined) {
      await this.options.rememberSpace(msg.user_id, space.id);
    }

    this.sentToday += 1;
    this.rejections = 0;
    this.lastLine = result.phone;

    return {
      message_id: result.message_id,
      provider: "spectrum",
      protocol: protocolFor(result.service),
      line_id: result.phone,
    };
  }

  /** Fire typing indicator — target <200ms. Called before any routing or model call. */
  async sendTypingIndicator(user_id: string): Promise<void> {
    try {
      const { handle, spaceId } = await this.options.spaceFor(user_id);
      if (spaceId === null) return; // no conversation yet, nothing to type into
      const space = await this.options.port.getSpace(spaceId);
      await this.options.port.send(space, [{ kind: "typing" }]);
    } catch {
      // Typing indicator failure must never block or throw — it's an enhancement,
      // not a correctness requirement.
    }
  }

  async capabilities(): Promise<Capabilities> {
    // From config. Probing would ask the transport a question whose answer is a billing
    // plan, and the answer would change under us on an upgrade with nothing in the log.
    return {
      tapbacks: true,
      images: true,
      groups: this.options.groups ?? false,
      typing: true,
      richlinks: true,
      contact_cards: true,
      threading: true,
    };
  }

  async health(): Promise<ChannelHealth> {
    const quota = this.options.dailyQuota ?? FREE_DAILY_QUOTA;
    const status: ChannelHealth["status"] = this.rejections >= BAN_AFTER_REJECTIONS
      ? "banned"
      : this.sentToday >= quota * DEGRADED_AT ? "degraded" : "up";
    return {
      status,
      // **`null` is normal here, not an error.** On a shared pool the line is per
      // conversation and chosen at send time, so there is no single correct value — this
      // reports the most recent one and nothing before the first send.
      line_id: this.lastLine,
      checked_at: new Date().toISOString(),
    };
  }

  normalizeInbound(rawBody: Buffer | string, signature: string, timestamp?: string): InboundMessage {
    const secret = process.env["SPECTRUM_WEBHOOK_SECRET"] ?? "";
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const parsed = JSON.parse(body) as Record<string, unknown>;

    // The timestamp rides in the body's own field when the caller passes only a
    // signature — Fastify hands both headers to the route, which is where the real one
    // comes from; this keeps the frozen two-argument shape honest either way.
    // On Photon Pro the timestamp arrives as x-spectrum-timestamp header, not in the
    // body. The 3rd optional parameter carries it from the webhook route.
    const ts = timestamp ?? String(parsed["timestamp"] ?? "");
    const check = verifySignature({
      secret,
      rawBody: body,
      signatureHeader: signature,
      timestampHeader: ts,
    });
    // ONE response for four reasons. `CONTRACTS.md` § 2 makes this `401 bad_signature` at
    // the route; distinguishing them to the caller would make the check an oracle.
    if (!check.ok) throw new Error(`bad_signature(${check.reason})`);

    const message = (parsed["message"] ?? {}) as Record<string, unknown>;
    const sender = (parsed["sender"] ?? {}) as Record<string, unknown>;
    return {
      schema_version: "inbound.v1",
      provider: "spectrum",
      provider_message_id: String(message["id"] ?? ""),
      line_id: String(parsed["line"] ?? "shared"),
      from_handle: String(sender["address"] ?? ""),
      // ADVISORY at most, and this transport does not derive it. `CONTRACTS.md` § 4:
      // `from_handle` is authoritative and the consumer re-derives.
      user_id: null,
      received_at: new Date().toISOString(),
      kind: "text",
      text: typeof message["text"] === "string" ? message["text"] : null,
      protocol: protocolFor((sender["service"] as SpectrumService) ?? "unknown"),
      trace_id: typeof parsed["trace_id"] === "string" ? parsed["trace_id"] : null,
    };
  }
}

/**
 * `outbound.v1` blocks to Photon parts.
 *
 * A `contact_card` block maps to Photon's `nativeContactCard()`, which sends the
 * project's own card. The block's `name` and `handle` are not passed through: the
 * transport already knows its own identity, and a card built from what the composer
 * happens to think our handle is would be wrong exactly when the config is.
 */
export function blocksToParts(msg: OutboundMessage): SpectrumPart[] {
  const parts: SpectrumPart[] = [];
  for (const block of msg.blocks) {
    if (block.type === "text") {
      parts.push({ kind: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        kind: "attachment",
        url: block.url,
        // EXPLICIT. The card's URL ends in a signature, so there is no extension for a
        // receiver to infer from — a guessed type is the acquisition artifact arriving as
        // a file nobody can open.
        mimeType: CARD_MIME,
        name: "boi-card.png",
      });
    } else {
      // NATIVE, not text. The first version wrote `${name}: ${handle}` and the dry run
      // showed it arriving as `Boi: +15550100123` — a line that reads like debug output,
      // in the first reply, which is exactly where AMENDMENT-002 moved the contact card
      // to make it a courtesy rather than a mechanism.
      parts.push({ kind: "contact_card" });
    }
  }
  return parts;
}
