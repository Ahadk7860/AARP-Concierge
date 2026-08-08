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

import { boiHandle } from "../../api/src/welcome.js";
import { readTodaysCard, todaysCardUrl, writeTodaysCard } from "../../card/src/store.js";
import { itemBlocks } from "./deliver.js";
import { localDayKey } from "./scheduler.js";
import type { Brief, Candidate, Channel, InboundMessage, OutboundMessage } from "../../shared/src/index.js";
import {
  consumePairingCode,
  createUser,
  findOutboundByProviderMessageId,
  findUserIdByHandle,
  liveCodeFor,
  listOutboundMessages,
  setHandleStatus,
  getPool,
  issuePairingCode,
  latestBrief,
  latestDigest,
  type UserScope,
} from "../../db/src/index.js";

/** Six digits, alone. The other thing a user might reasonably text. */
export function parsePairingCode(text: string | null): string | null {
  if (text === null) return null;
  const match = /^\s*([0-9]{6})\s*[.!]?\s*$/.exec(text);
  return match?.[1] ?? null;
}

/** Setup token — creates an account without a web signup. */
function isSetupToken(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim().toLowerCase();
  return trimmed === "boi-setup"
    || trimmed.startsWith("boi-setup ") || trimmed.endsWith(" boi-setup")
    || trimmed.includes(" boi-setup ");
}

/**
 * The AMENDMENT-002 pairing token, `boi-4f2a91`, ANYWHERE in the message.
 *
 * Loose on purpose, and in exactly one direction. The body arrives prefilled from an
 * `sms:` link and is **user-editable**: people add "hi", they add a question mark, some
 * of them type a whole sentence around it before hitting send. Requiring the token to
 * stand alone would reject all of that and answer the one thing we asked them to do with
 * a re-prompt.
 *
 * It cannot collide with anything else Boi understands: `1`, `2` and six bare digits are
 * all anchored to the whole message, and no draft selection contains `boi-`.
 */
export function parsePairingToken(text: string | null): string | null {
  if (text === null) return null;
  const match = /\bboi-([0-9a-f]{6})\b/i.exec(text);
  return match === null ? null : `boi-${match[1]!.toLowerCase()}`;
}

/**
 * `send my friends report`, matched generously.
 *
 * **Advertise one phrase, match loosely around it.** Somebody told to text
 * "send my friends report" will type "hi boi, i'd like to receive my friends report", or
 * "friends report please", or just "report". Exact-string matching fails the user who was
 * polite, and being told the magic words did not work is worse than never being offered
 * them.
 *
 * Generous in ONE direction only. `1`, `2`, six digits and `boi-…` tokens are all matched
 * ahead of this and are anchored to the whole message, so a draft selection cannot become
 * a report request no matter how this widens.
 */
export function parseReportRequest(text: string | null): boolean {
  if (text === null) return false;
  // `report` is the load-bearing word; `friends` is optional because half the people who
  // were told the phrase will drop it. A bare "friends" is NOT enough — "how are my
  // friends" is a question this product cannot answer and must not pretend to.
  return /\breports?\b/i.test(text);
}

/**
 * `yes`, and the handful of ways people write it.
 *
 * Anchored to the whole message, unlike the report intent: `yes` inside a sentence is
 * usually not an answer to our question, and this matcher is only consulted when a brief
 * is actually waiting on one.
 */
const AFFIRMATIVE = new Set([
  "y", "ya", "yea", "yeah", "yes", "yep", "yup", "sure", "ok", "okay", "k",
  "please", "pls", "list", "show", "them", "me", "go", "on", "do", "it", "definitely",
]);

export function parseAffirmative(text: string | null): boolean {
  if (text === null) return false;
  // EVERY word must be affirmative, rather than the whole reply being one token.
  //
  // The first version was anchored to a single word, and the first real human reply was
  // **"yes sure"** — two affirmatives in a row, which is how people actually answer, and
  // exactly what the anchor rejected. The reasoning behind anchoring was sound (a `yes`
  // buried in a sentence is not always an answer) and the implementation was too literal.
  //
  // Still narrow in the direction that matters: "yes but not now" contains `but` and
  // `now`, so it is NOT a yes. Treating anything containing "yes" as consent is how an
  // assistant sends a list to somebody who was declining.
  const words = text.toLowerCase().replace(/[.!,?]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((w) => AFFIRMATIVE.has(w));
}

export type Selection =
  | { kind: "selected"; item_index: number; candidate_index: number; candidate: Candidate; brief_id: string }
  | { kind: "ambiguous"; brief_id: string; item_count: number }
  | { kind: "no_brief" }
  | { kind: "no_drafts"; item_index: number; brief_id: string }
  | { kind: "pairing_code"; code: string; bound: boolean }
  /**
   * The report, on request. THREE outcomes, and the first two are not the same claim.
   *
   * - `no_corpus` — **"I don't have your history yet."** A claim about US. Under
   *   AMENDMENT-002 the thread exists before the Mac app does, so the single most likely
   *   report request in the product arrives before any digest exists: somebody reads
   *   "text me: send my friends report" and does it immediately, or texts while the scan
   *   is still running.
   * - `refusal` — **"I read your history and there is not enough of it."** A claim about
   *   THEM, and only sayable once we have actually looked.
   * - `standard` — the card.
   *
   * Getting the first two backwards tells a brand-new user their friendships are too thin
   * to measure when we simply have not looked yet. That is the confident wrong answer the
   * architecture names as the failure that costs trust permanently, and it is one `if`
   * away at all times.
   */
  /**
   * The opener asked "want me to list them?" and they said yes.
   *
   * The three items follow. A NON-affirmative reply deliberately does not produce this —
   * see `awaiting_list`: "no" meaning "yes" is the kind of thing that gets an assistant
   * muted, and the whole point of asking was to find out.
   */
  | { kind: "list_items"; brief_id: string; item_count: number }
  /** A brief is waiting on an answer and the reply was not one. Acknowledge, send nothing. */
  | { kind: "awaiting_list"; brief_id: string }
  | { kind: "report"; outcome: "no_corpus" | "refusal" | "standard"; cached: boolean }
  /** AMENDMENT-002: the prefilled token came back, and the account is now paired. */
  | { kind: "paired"; token: string }
  /**
   * A first message from somebody with a live token that carried no recognisable one.
   *
   * They deleted the prefilled body, mangled it, or sent an empty message — all three are
   * things people do, and all three deserve the same answer. Silence would be the worst
   * possible response: they have just done the one thing we asked and got nothing back.
   */
  | { kind: "needs_token"; token: string }
  | { kind: "not_a_selection" }
  | { kind: "unknown_user" }
  /** `user_id` disagreed with `from_handle`. CONTRACTS.md § 4: reject, do not correct. */
  | { kind: "handle_mismatch" };

/** `1` or `2`, alone, possibly with whitespace or a trailing full stop. */
export function parseSelection(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*([12])\s*[.!]?\s*$/.exec(text);
  if (match === null) return null;
  return Number(match[1]) - 1;
}

export type UserResolution =
  | { kind: "resolved"; scope: UserScope }
  | { kind: "unknown_handle" }
  /** The transport's `user_id` disagreed with the handle it was derived from. */
  | { kind: "mismatch"; claimed: string; derived: string };

/**
 * Resolve the user an inbound message belongs to.
 *
 * **`from_handle` is AUTHORITATIVE; `inbound.v1.user_id` is ADVISORY.** CONTRACTS.md § 4,
 * decided 2 Aug. Track C populates `user_id` by running an injected resolver over
 * `from_handle`, which makes it a DERIVED field — and re-deriving something you hold the
 * input for is strictly stronger than trusting the derivation you were handed.
 *
 * This used to return the claimed id whenever it parsed, and only fell back to the
 * handle when it was absent. A resolver bug, or a transport compromise, meant reading
 * and writing the wrong account — acting on user A's behalf because something said so.
 *
 * Defence in depth rather than the primary gate: the signature is the real barrier and a
 * forged webhook cannot be signed. But a signature proves *the provider sent this*, not
 * *this handle belongs to that account*, and those are different claims.
 */
export async function resolveUserStrict(inbound: InboundMessage): Promise<UserResolution> {
  // PHONE OR EMAIL. Messages on a Mac frequently sends from the Apple Account email, and
  // an unresolvable handle is answered with silence — so resolving by phone alone would
  // make that user's first message vanish with no error anywhere.
  const derived = await findUserIdByHandle(inbound.from_handle);
  if (derived === null) return { kind: "unknown_handle" };

  const claimed = inbound.user_id;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== derived.user_id) {
    // A rejection, not a warning. Continuing on the derived id would be quietly
    // correcting a transport that is telling us something is wrong.
    return { kind: "mismatch", claimed, derived: derived.user_id };
  }
  return { kind: "resolved", scope: derived };
}

/** The scope, or null. Kept for callers that do not need to tell the two failures apart. */
export async function resolveUser(inbound: InboundMessage): Promise<UserScope | null> {
  const resolution = await resolveUserStrict(inbound);
  return resolution.kind === "resolved" ? resolution.scope : null;
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

/**
 * A brief whose opener went out and whose items have not.
 *
 * Detected from `messages_out` rather than from a flag on the brief: the opener and the
 * items are both send records, so "did we ask" and "did we answer" are the same kind of
 * fact and neither can drift from the other.
 */
async function pendingOpener(
  scope: UserScope,
  db: Parameters<typeof latestBrief>[1],
): Promise<{ brief_id: string; items: number } | null> {
  const row = await latestBrief(scope, db);
  if (row === null) return null;
  const sent = await listOutboundMessages(scope, db);
  const asked = sent.some((m) => m.idempotency_key.endsWith("-opener"));
  const listed = sent.some((m) => m.idempotency_key.includes("-item-"));
  if (!asked || listed) return null;
  return { brief_id: row.brief_id, items: row.payload.items.length };
}

export async function resolveSelection(
  inbound: InboundMessage,
  scope: UserScope,
  deps: ResolveDeps = {},
): Promise<Selection> {
  const db = deps.db ?? getPool();

  // THE PAIRING TOKEN, before anything else. AMENDMENT-002.
  //
  // Ordered first because it is the narrowest matcher and because it is the one message
  // in the product that is not a reply to anything — under the inverted flow it is the
  // first thing the user ever sends.
  const token = parsePairingToken(inbound.text);
  if (token !== null) {
    // Scoped consumption IS the binding check: a token issued to A cannot be consumed
    // under B's scope, because the update names both. Single use is the same statement —
    // `consumed_at is null` in the where clause, so a replay updates zero rows.
    const consumed = await consumePairingCode(scope, token, deps.now ?? new Date(), db);
    if (consumed) return { kind: "paired", token };
    // Expired, already used, or somebody else's. All three get the same answer, and it
    // is a re-prompt rather than an error: the user cannot tell those apart and does not
    // need to.
    const live = await liveCodeFor(scope, deps.now ?? new Date(), db);
    if (live !== null) return { kind: "needs_token", token: live };
  }

  // A FIRST MESSAGE THAT LOST ITS TOKEN. The body is editable and empty messages happen.
  // Only for somebody who has a live secret waiting — an established user texting "hi"
  // is not onboarding and must not be re-prompted at.
  if (parseSelection(inbound.text) === null && parsePairingCode(inbound.text) === null) {
    const live = await liveCodeFor(scope, deps.now ?? new Date(), db);
    if (live !== null && live.startsWith("boi-")) {
      return { kind: "needs_token", token: live };
    }
  }

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

  // THE ANSWER TO THE OPENER, before the report intent and before the 1/2 fallback.
  //
  // Only consulted when a brief actually went out as an opener and its items have not
  // been sent — otherwise "ok" from an established user would replay this morning's list
  // at them.
  const pending = await pendingOpener(scope, db);
  if (pending !== null) {
    if (parseAffirmative(inbound.text)) {
      return { kind: "list_items", brief_id: pending.brief_id, item_count: pending.items };
    }
    if (parseSelection(inbound.text) === null && parsePairingToken(inbound.text) === null) {
      // Anything that is not a yes is not a yes. Acknowledged, and the list is not sent.
      return { kind: "awaiting_list", brief_id: pending.brief_id };
    }
  }

  const candidateIndex = parseSelection(inbound.text);
  if (candidateIndex === null) {
    // THE REPORT, ON REQUEST. Ordered after every anchored matcher above and before the
    // "reply 1 or 2" fallback, which is where a message that means something else used to
    // land. The outcome is decided in `handleInbound`, which holds the renderer.
    if (parseReportRequest(inbound.text)) {
      return { kind: "report", outcome: "no_corpus", cached: false };
    }
    return { kind: "not_a_selection" };
  }

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
    case "list_items":
      // The items are built in `handleInbound`, which holds the brief. Nothing here.
      return [];
    case "awaiting_list":
      // Acknowledged, and the list is NOT sent. Treating anything-but-no as yes is how an
      // assistant gets muted, and asking was the point.
      return [{
        type: "text",
        text: "no problem — say the word any time and i'll run through them.",
      }];
    case "report":
      // The image and the standard-card lead-in are built in `handleInbound`, which holds
      // the renderer and the user id. Only the two TEXT-ONLY outcomes are answered here.
      if (selection.outcome === "no_corpus") {
        // A claim about US, and it names the step that fixes it. Never a refusal card:
        // "there is not enough of your history" is a different sentence and we have not
        // earned the right to say it yet.
        return [{
          type: "text",
          text:
            "i don't have your history yet — that all happens on your mac. finish setting "
            + "up the app (or give the first scan a minute) and ask me again.",
        }];
      }
      return [];
    case "paired":
      // The download link and the contact card are built in `handleInbound`, which is
      // the only place that knows the user id. This branch returns nothing so the
      // message is not sent twice.
      return [];
    case "needs_token":
      // Never says what was wrong with what they sent. The honest answer would be "you
      // deleted the code we hid in your message", which reads as a scolding for
      // something we made invisible on purpose.
      return [{ type: "text", text: `almost — text me this and we're set: ${selection.token}` }];
    case "not_a_selection":
      return [{ type: "text", text: "reply 1 or 2 to pick a draft." }];
    case "unknown_user":
    case "handle_mismatch":
      // Silence, both times. Replying to an unknown handle confirms to a stranger that
      // this number is a service; replying to a mismatch answers a request whose
      // provenance is in doubt.
      return [];
  }
}

export type HandleInboundResult = {
  selection: Selection;
  /** Exactly the messages sent — always to the user, never onward. */
  sent: OutboundMessage[];
};

/**
 * Boi's FIRST REPLY, which is now the first thing Boi ever says.
 *
 * Three jobs, in this order and for this reason:
 *
 * 1. **The download link.** This is the ordering AMENDMENT-002 turns on — Boi is useful
 *    before it asks for anything. The Full Disk Access request then lands as "the thing I
 *    already asked for needs this" rather than as a stranger wanting a message history,
 *    and no other ordering buys that.
 * 2. **The contact card**, demoted from mechanism to courtesy. The thread already exists
 *    and Boi is already known; saving the contact is now just convenient.
 * 3. Nothing else. The grant narration and the report offer are `08`'s neighbours, not
 *    its content.
 *
 * It lives HERE rather than on the API's onboarding surface for the reason the `Registrar`
 * port does not: `cloud/brief` has never imported `cloud/api`, and the first reply is a
 * reply — an inbound concern. Putting it beside the signup page would point an arrow from
 * the composer at the product surface for the sake of filing two messages together.
 */
export function firstReplyMessage(input: {
  user_id: string;
  download_url: string;
}): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: input.user_id,
    // Keyed on the user, so a duplicate inbound cannot produce two first replies:
    // `messages_out` has `unique (user_id, idempotency_key)`.
    idempotency_key: `firstreply-${input.user_id}`,
    blocks: [
      {
        type: "text",
        text:
          "paired — nice to meet you. next: install the mac app and i'll read your "
          + `message history locally, on your machine.\n${input.download_url}`,
      },
      { type: "contact_card", name: "Boi", handle: boiHandle() },
    ],
    reply_to_message_id: null,
    requested_capabilities: ["contact_cards"],
  };
}

/** Where the Mac app is downloaded from. Config, because it changes per environment. */
export function downloadUrl(): string {
  return process.env["BOI_DOWNLOAD_URL"] ?? "https://boi.app/download";
}

/**
 * The report, served: cache, render, send.
 *
 * Returns `null` when there is no corpus, which is the one outcome that is a sentence
 * rather than an image — and the caller answers it with `replyBlocks`.
 */
async function serveReport(input: {
  scope: UserScope;
  channel: Channel;
  renderCard?: (scope: UserScope, digest: unknown) => Promise<{
    url: string | null;
    kind: "standard" | "refusal" | null;
    card_id?: string | null;
    reason?: string | null;
  }>;
  now: Date;
  timezone: string;
  cardBaseUrl?: string | null;
  db?: ResolveDeps["db"];
  log: (event: Record<string, unknown>) => void;
}): Promise<HandleInboundResult | null> {
  const { scope, channel, now, log } = input;

  // NO CORPUS IS NOT A REFUSAL. Under AMENDMENT-002 the thread predates the Mac app, so
  // this is the likeliest report request in the product — and "there is not enough of
  // your history" would be a confident claim about somebody we have never looked at.
  const digest = await latestDigest(scope, input.db ?? getPool());
  if (digest === null) {
    log({ msg: "report.no_corpus", user_id: scope.user_id });
    return null;
  }

  const dayKey = localDayKey(now, input.timezone);
  const cached = readTodaysCard(scope.user_id, dayKey);

  // Rebuilt from `card_id` rather than replayed: a cached absolute URL breaks on expiry,
  // on a key rotation and on a hostname change, and it breaks by handing the user a link
  // that refuses to load.
  let url = cached === null ? null : todaysCardUrl(cached, input.cardBaseUrl ?? null);
  let kind = cached?.kind ?? null;
  if (cached === null) {
    const rendered = input.renderCard
      ? await input.renderCard(scope, digest.payload)
      : { url: null, kind: null as "standard" | "refusal" | null, card_id: null };
    url = rendered.url;
    kind = rendered.kind;
    if (kind !== null) {
      writeTodaysCard(scope.user_id, {
        day_key: dayKey,
        card_id: rendered.card_id ?? null,
        card_url: rendered.url,
        kind,
        served_at: now.toISOString(),
      });
    }
  }

  const blocks: OutboundMessage["blocks"] = [];
  if (kind === "standard" && url !== null) {
    blocks.push({ type: "text", text: "here's where your friendships stand right now:" });
    blocks.push({ type: "image", url, alt: "your relationships this week" });
  } else {
    // A REFUSAL, ON REQUEST, IS FINE — and the standing rule that it is never attached to
    // a scheduled brief still holds. Daily and unasked it is a reproach; asked for
    // directly it is the honest answer to a direct question, and it MUST say what would
    // change it. A refusal with no remedy is the guilt-without-agency the product
    // conventions forbid.
    blocks.push({
      type: "text",
      text:
        "i've read your history and there isn't enough of it yet for a report i'd stand "
        + "behind — i need more months of messages. check Settings > Messages > Keep "
        + "Messages, and if it's set to 30 days or a year, that's the cap.",
    });
  }

  if (cached !== null) {
    // Served twice today. Say so rather than reprinting yesterday's number as if it were
    // new: the card is dated by design, and a silent repeat is what makes people stop
    // believing the figure.
    blocks.push({
      type: "text",
      text: "same card as earlier today — it updates once a day, after your mac syncs.",
    });
  }

  const message: OutboundMessage = {
    schema_version: "outbound.v1",
    user_id: scope.user_id,
    // Keyed on the DAY and the attempt, so a provider redelivery of the same request does
    // not send twice while a genuine second request still gets an answer.
    idempotency_key: `report-${scope.user_id}-${dayKey}-${cached === null ? "first" : now.getTime()}`,
    blocks,
    reply_to_message_id: null,
  };
  await channel.send(message);

  log({
    msg: "report.served",
    user_id: scope.user_id,
    kind: kind ?? "none",
    cached: cached !== null,
  });
  return {
    selection: {
      kind: "report",
      outcome: kind === "standard" ? "standard" : "refusal",
      cached: cached !== null,
    },
    sent: [message],
  };
}

export async function handleInbound(input: {
  inbound: InboundMessage;
  channel: Channel;
  db?: ResolveDeps["db"];
  now?: Date;
  /** The user's zone, for the day key the report cache is bucketed on. */
  timezone?: string;
  /** Where the card service lives, so a cached card's URL is rebuilt rather than replayed. */
  cardBaseUrl?: string | null;
  /**
   * Renders and hosts a card. Absent means no renderer is configured, which is a
   * legitimate deployment and costs the image rather than the answer.
   */
  renderCard?: (scope: UserScope, digest: unknown) => Promise<{
    url: string | null;
    kind: "standard" | "refusal" | null;
    card_id?: string | null;
    reason?: string | null;
  }>;
  log?: (event: Record<string, unknown>) => void;
}): Promise<HandleInboundResult> {
  const log = input.log ?? (() => {});
  const resolution = await resolveUserStrict(input.inbound);

  if (resolution.kind === "mismatch") {
    // Loud in the log, silent to the sender. This is a transport bug or a compromise,
    // and it is the one inbound condition an operator needs to see immediately.
    log({
      msg: "inbound.handle_mismatch",
      provider: input.inbound.provider,
      claimed_user_id: resolution.claimed,
      derived_user_id: resolution.derived,
    });
    return { selection: { kind: "handle_mismatch" }, sent: [] };
  }

  if (resolution.kind === "unknown_handle") {
    // Auto-setup: when an unknown handle texts the setup token, create their account
    // on the fly. Skips the web signup — the phone number is the identity, and the
    // token proves intent. On Photon Pro there is no allowlist to register.
    if (isSetupToken(input.inbound.text)) {
      const phone = input.inbound.from_handle;
      if (phone && /^\+[1-9][0-9]{6,14}$/.test(phone)) {
        try {
          const created = await createUser({ phone_e164: phone });
          log({ msg: "inbound.auto_setup_created", provider: input.inbound.provider });
          // Re-resolve and proceed with the created scope.
          const scope = created.scope;
          const setupReply: OutboundMessage = {
            schema_version: "outbound.v1",
            user_id: scope.user_id,
            idempotency_key: `setup-${scope.user_id}`,
            blocks: [{
              type: "text" as const,
              text: "all set — i haven't read your messages yet. download the Mac app to get started, then tap 'Start the conversation' when it's installed. you can also ask me things like 'who should i follow up with' once your history is synced.",
            }],
            reply_to_message_id: null,
          };
          await input.channel.send(setupReply);
          log({ msg: "inbound.auto_setup_welcomed", user_id: scope.user_id });
          return { selection: { kind: "paired" as const, token: "boi-setup" }, sent: [setupReply] };
        } catch (err) {
          log({ msg: "inbound.auto_setup_failed",
            provider: input.inbound.provider,
            error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }
    // An inbound from a handle with no account. Nothing to say and nobody to say it to;
    // replying would confirm to a stranger that this number is a service.
    log({ msg: "inbound.unknown_user", provider: input.inbound.provider });
    return { selection: { kind: "unknown_user" }, sent: [] };
  }

  const scope = resolution.scope;

  const selection = await resolveSelection(input.inbound, scope, {
    db: input.db,
    now: input.now,
  });

  let display: string | undefined;
  if (selection.kind === "no_drafts" || selection.kind === "selected") {
    const row = await latestBrief(scope, input.db ?? getPool());
    display = row?.payload.items[selection.item_index]?.display;
  }

  // THE ITEMS, now that they have said yes. One message per person, into a conversation
  // the user has just opened — which is what lifts the new-contact cap as well as being
  // the polite shape.
  if (selection.kind === "list_items") {
    const row = await latestBrief(scope, input.db ?? getPool());
    const sent: OutboundMessage[] = [];
    for (const [index, item] of (row?.payload.items ?? []).entries()) {
      const message: OutboundMessage = {
        schema_version: "outbound.v1",
        user_id: scope.user_id,
        idempotency_key: `brief-${scope.user_id}-${row?.payload.scheduled_for}-item-${index}`,
        blocks: itemBlocks(item),
        reply_to_message_id: null,
      };
      await input.channel.send(message);
      sent.push(message);
    }
    log({ msg: "brief.items_listed", user_id: scope.user_id, items: sent.length });
    return { selection, sent };
  }

  // THE REPORT, ON REQUEST — the path that makes the kill test runnable.
  //
  // Twenty people asking for their report and screenshotting it is the same evidence as
  // twenty receiving one, and it needs no scheduler and no waiting until 8am tomorrow.
  // People are most curious in the ninety seconds after their history finishes loading,
  // and the scheduled brief asks them to sleep on it.
  if (selection.kind === "report") {
    const served = await serveReport({
      scope,
      channel: input.channel,
      renderCard: input.renderCard,
      cardBaseUrl: input.cardBaseUrl ?? process.env["BOI_CARD_PUBLIC_BASE"]
        ?? process.env["BOI_CARD_BASE"] ?? null,
      now: input.now ?? new Date(),
      timezone: input.timezone ?? "America/Los_Angeles",
      db: input.db,
      log,
    });
    if (served !== null) return served;
    // No corpus: answered as text by `replyBlocks` below, with the step that fixes it.
  }

  // THE FIRST REPLY. AMENDMENT-002's ordering: Boi delivers the download link before it
  // asks for anything, so the Full Disk Access request that follows lands as "the thing I
  // already asked for needs this" rather than as a stranger wanting a message history.
  //
  // Built here rather than in `replyBlocks` because it needs the user id for its
  // idempotency key: a provider redelivery of the pairing message must not send two
  // first replies.
  if (selection.kind === "paired") {
    // HANDLE-MISMATCH DETECTION, RELOCATED RATHER THAN LOST.
    //
    // It used to come from the protocol of the welcome message we sent. Under
    // AMENDMENT-002 nothing is sent first, so the same fact arrives from the other
    // direction — the protocol of the message the USER sent — and it is strictly better
    // evidence: an outbound send tells us how we reached them, an inbound tells us what
    // their Messages app actually is.
    //
    // `null` protocol stays `unknown`. A transport that does not report one must not be
    // silently recorded as a mismatch, because "we don't know whether this was blue" and
    // "this was green" are different facts and only one of them is true.
    const protocol = input.inbound.protocol ?? null;
    if (protocol !== null) {
      await setHandleStatus(scope, protocol === "imessage" ? "imessage" : "mismatch");
    }

    const first = firstReplyMessage({
      user_id: scope.user_id,
      download_url: downloadUrl(),
    });
    await input.channel.send(first);
    log({
      msg: "inbound.paired",
      user_id: scope.user_id,
      kind: selection.kind,
      // The token is a bearer credential. It is never logged, here or at signup.
    });
    return { selection, sent: [first] };
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
