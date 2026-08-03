// What a reply means.
//
// The reply that matters is `2` — "I'll take the second draft." Note what it does NOT
// do: it does not send anything to anybody. Boi hands the text back to the user and the
// user sends it from their own Messages app. That line does not move, not behind a
// flag, not for a friendly beta user.
//
// THE ATTRIBUTION PROBLEM, and why the mapping had to be written down at send time.
//
// `inbound.v1.reply_to_message_id` carries the PROVIDER's id for the message being
// replied to — `lmsg_...` from Linq, `omsg_stub_2` from the foundation stub. Track D
// owns the mapping back to its own `omsg_`, and the only place that link ever exists is
// `SendResult.message_id`, returned once at send time and never again. `deliver.ts`
// writes it to `messages_out.provider_message_id`; this file reads it back.
//
// Nothing here parses the id. It is matched, never inspected, so a transport that
// changes its prefix changes nothing in this file.

import type { Brief, Candidate, Channel, InboundMessage, OutboundMessage } from "../../shared/src/index.js";
import {
  findOutboundByProviderMessageId,
  findUserIdByPhone,
  getPool,
  issuePairingCode,
  latestBrief,
  unsafeScopeFromUserId,
  type UserScope,
} from "../../db/src/index.js";

/** Six digits, alone. The other thing a user might reasonably text. */
export function parsePairingCode(text: string | null): string | null {
  if (text === null) return null;
  const match = /^\s*([0-9]{6})\s*[.!]?\s*$/.exec(text);
  return match?.[1] ?? null;
}

export type Selection =
  | { kind: "selected"; item_index: number; candidate_index: number; candidate: Candidate; brief_id: string }
  | { kind: "ambiguous"; brief_id: string; item_count: number }
  | { kind: "no_brief" }
  | { kind: "no_drafts"; item_index: number; brief_id: string }
  | { kind: "pairing_code"; code: string; bound: boolean }
  | { kind: "not_a_selection" }
  | { kind: "unknown_user" };

/** `1` or `2`, alone, possibly with whitespace or a trailing full stop. */
export function parseSelection(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*([12])\s*[.!]?\s*$/.exec(text);
  if (match === null) return null;
  return Number(match[1]) - 1;
}

/**
 * Resolve the user an inbound message belongs to.
 *
 * `inbound.v1.user_id` when the transport already knows. Otherwise the sender's own
 * handle: this is the ACCOUNT HOLDER texting their own assistant, and CONTRACTS.md § 3
 * says the account holder's handle is the one handle the server does see. Doing it this
 * way keeps every subsequent read user-scoped rather than adding a third unscoped
 * lookup to `bootstrapLookups`.
 */
export async function resolveUser(inbound: InboundMessage): Promise<UserScope | null> {
  if (typeof inbound.user_id === "string" && inbound.user_id.length > 0) {
    try {
      return unsafeScopeFromUserId(inbound.user_id);
    } catch {
      // A transport handing us a malformed id is a transport bug, not a user. Fall
      // through to the handle rather than throwing at the edge of the system.
    }
  }
  return findUserIdByPhone(inbound.from_handle);
}

export type ResolveDeps = { db?: Parameters<typeof latestBrief>[1]; now?: Date };

/** Ten minutes, matching `contracts/openapi/boi-api.v1.yaml`. */
export const PAIRING_TTL_SECONDS = 600;

/**
 * Which draft the user picked, if any.
 *
 * Threaded: `reply_to_message_id` names the message, which names the item. Unthreaded:
 * fall back to the most recent brief — and if that brief has more than one item, say so
 * rather than guessing. "Handling a reply that matches no brief, without guessing"
 * applies just as much to a reply that matches three items equally well.
 */
export async function resolveSelection(
  inbound: InboundMessage,
  scope: UserScope,
  deps: ResolveDeps = {},
): Promise<Selection> {
  const db = deps.db ?? getPool();

  // A TEXTED PAIRING CODE, before anything else.
  //
  // The frozen welcome message says "when the Mac app is set up, text me your pairing
  // code", and until now a user who did exactly that hit `parseSelection`, matched
  // nothing, and got back "reply 1 or 2 to pick a draft". Binding it here makes the
  // instruction true, and the Mac's subsequent POST /v1/pair resolves it.
  //
  // Six digits cannot collide with a draft selection: `parseSelection` takes only a
  // bare 1 or 2.
  const code = parsePairingCode(inbound.text);
  if (code !== null) {
    try {
      await issuePairingCode(scope, { code, ttl_seconds: PAIRING_TTL_SECONDS, now: deps.now });
      return { kind: "pairing_code", code, bound: true };
    } catch {
      // Another account is holding it. `issuePairingCode` guarantees global uniqueness
      // of a live code under an advisory lock, so refusing is the only safe answer —
      // rebinding would hand this user's Mac somebody else's account.
      return { kind: "pairing_code", code, bound: false };
    }
  }

  const candidateIndex = parseSelection(inbound.text);
  if (candidateIndex === null) return { kind: "not_a_selection" };

  let itemIndex: number | null = null;
  let brief: Brief | null = null;
  let briefId: string | null = null;

  const replyTo = inbound.reply_to_message_id;
  if (typeof replyTo === "string" && replyTo.length > 0) {
    const attribution = await findOutboundByProviderMessageId(scope, replyTo, db);
    if (attribution !== null && attribution.brief_id !== null) {
      briefId = attribution.brief_id;
      itemIndex = attribution.item_index;
    }
  }

  const row = await latestBrief(scope, db);
  if (row === null) return { kind: "no_brief" };

  // A threaded reply naming a brief we no longer hold is not the latest brief's.
  if (briefId !== null && briefId !== row.brief_id) return { kind: "no_brief" };
  brief = row.payload;
  briefId = row.brief_id;

  if (itemIndex === null) {
    // Unthreaded. Attributed to the most recent brief, per the prompt — but only
    // resolvable to an ITEM when there is exactly one candidate for what they meant.
    if (brief.items.length === 1) itemIndex = 0;
    else return { kind: "ambiguous", brief_id: briefId, item_count: brief.items.length };
  }

  const item = brief.items[itemIndex];
  if (item === undefined) return { kind: "no_brief" };

  const candidates = item.drafts?.candidates ?? [];
  // A degraded item has no drafts. "2" cannot select one, and inventing text to send in
  // the user's own name is the fabrication the whole architecture is built to avoid.
  if (candidates.length === 0) return { kind: "no_drafts", item_index: itemIndex, brief_id: briefId };

  const candidate = candidates[candidateIndex];
  if (candidate === undefined) {
    return { kind: "no_drafts", item_index: itemIndex, brief_id: briefId };
  }

  return {
    kind: "selected",
    item_index: itemIndex,
    candidate_index: candidateIndex,
    candidate,
    brief_id: briefId,
  };
}

/**
 * What Boi says back.
 *
 * On a selection it returns the draft TEXT, for the user to copy or forward. Nothing
 * here addresses the third party, and `outbound.v1` has no field that could.
 */
export function replyBlocks(selection: Selection, display?: string): OutboundMessage["blocks"] {
  switch (selection.kind) {
    case "selected":
      return [
        { type: "text", text: "here it is — copy or forward it whenever you're ready:" },
        { type: "text", text: selection.candidate.text },
      ];
    case "ambiguous":
      return [
        {
          type: "text",
          text: `which one — reply with the name (${selection.item_count} people this morning)`,
        },
      ];
    case "no_drafts":
      return [
        {
          type: "text",
          text:
            display === undefined
              ? "no drafts for that one — say what you want and i'll help"
              : `no drafts for ${display} — say what you want and i'll help`,
        },
      ];
    case "no_brief":
      return [{ type: "text", text: "can't find that one. i'll be back tomorrow morning." }];
    case "pairing_code":
      return [
        {
          type: "text",
          text: selection.bound
            ? "got it — that code is live for the next 10 minutes. finish setup on your Mac."
            : "that code is already in use. hit sign up again and i'll text you a fresh one.",
        },
      ];
    case "not_a_selection":
      return [{ type: "text", text: "reply 1 or 2 to pick a draft." }];
    case "unknown_user":
      return [];
  }
}

export type HandleInboundResult = {
  selection: Selection;
  /** Exactly the messages sent — always to the user, never onward. */
  sent: OutboundMessage[];
};

export async function handleInbound(input: {
  inbound: InboundMessage;
  channel: Channel;
  db?: ResolveDeps["db"];
  now?: Date;
  log?: (event: Record<string, unknown>) => void;
}): Promise<HandleInboundResult> {
  const log = input.log ?? (() => {});
  const scope = await resolveUser(input.inbound);

  if (scope === null) {
    // An inbound from a handle with no account. Nothing to say and nobody to say it to;
    // replying would confirm to a stranger that this number is a service.
    log({ msg: "inbound.unknown_user", provider: input.inbound.provider });
    return { selection: { kind: "unknown_user" }, sent: [] };
  }

  const selection = await resolveSelection(input.inbound, scope, {
    db: input.db,
    now: input.now,
  });

  let display: string | undefined;
  if (selection.kind === "no_drafts" || selection.kind === "selected") {
    const row = await latestBrief(scope, input.db ?? getPool());
    display = row?.payload.items[selection.item_index]?.display;
  }

  const blocks = replyBlocks(selection, display);
  if (blocks.length === 0) return { selection, sent: [] };

  const message: OutboundMessage = {
    schema_version: "outbound.v1",
    user_id: scope.user_id,
    // One reply per inbound message. A provider redelivery must not double-send.
    idempotency_key: `inbound-${input.inbound.provider_message_id}`,
    blocks,
    reply_to_message_id: null,
  };

  await input.channel.send(message);

  log({
    msg: "inbound.handled",
    user_id: scope.user_id,
    kind: selection.kind,
    // The selection, never the draft text — CONTRACTS.md § 6.
    item_index: selection.kind === "selected" ? selection.item_index : null,
    candidate_index: selection.kind === "selected" ? selection.candidate_index : null,
  });

  return { selection, sent: [message] };
}
