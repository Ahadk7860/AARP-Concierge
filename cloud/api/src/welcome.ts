// The first message, and why Boi sends it rather than waiting to be texted.
//
// iOS has a *Filter Unknown Senders* setting that routes messages from non-contacts
// into a separate tab WITH NO NOTIFICATION. The obvious signup flow — "here's our
// number, text it your code" — fails silently when it is on: the user texts the code,
// Boi replies perfectly, and the reply lands in a tab they never open. The product
// appears broken at exactly the moment it is supposed to feel like magic, and no error
// is raised anywhere.
//
// Sending FIRST closes it. An outbound message creates a thread the user already has
// open; the attached contact card makes one tap save Boi permanently, which takes the
// account out of the filtered tab for good; and the `sms:` deep link on the
// confirmation page opens that exact thread rather than asking anyone to copy a number.
//
// This is a correctness fix that looks like a growth hack. It is in the first group.

import type { OutboundMessage } from "../../shared/src/index.js";

/**
 * The handle Boi sends from.
 *
 * Read from `LINQ_FROM_HANDLE`, which `.env.example` already defines — the alternative
 * was inventing a second variable for the same value, and two names for one handle is
 * how they drift apart. The default matches
 * `contracts/fixtures/outbound/first_contact_card.json`.
 */
export function boiHandle(): string {
  return process.env["LINQ_FROM_HANDLE"] ?? "+15550100123";
}

/** Matches `contracts/fixtures/outbound/first_contact_card.json`. */
export const WELCOME_TEXT =
  "hey — this is Boi. save me so i don't end up in your filtered messages. " +
  "when the Mac app is set up, text me your pairing code.";

/**
 * The `outbound.v1` document for a new account.
 *
 * The `contact_card` block is not decoration — it is the entire mechanism by which the
 * account escapes the filtered tab. `requested_capabilities` names it so a transport
 * that cannot do contact cards degrades visibly rather than dropping the block.
 *
 * The idempotency key is derived from the user id, so a retried signup cannot send two
 * welcome messages: `messages_out` has `unique (user_id, idempotency_key)`.
 */
export function welcomeMessage(userId: string): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: userId,
    idempotency_key: `welcome-${userId}`,
    blocks: [
      { type: "text", text: WELCOME_TEXT },
      { type: "contact_card", name: "Boi", handle: boiHandle() },
    ],
    reply_to_message_id: null,
    requested_capabilities: ["contact_cards"],
  };
}

/**
 * The deep link that opens Messages on the thread Boi just created.
 *
 * `sms:` rather than `imessage:` on purpose — `sms:` is handled by Messages for both
 * protocols and degrades to the SMS composer, where `imessage:` fails outright on a
 * handle Apple has not registered. Which is the handle-mismatch case, and the one where
 * a dead link would be least recoverable.
 */
export function smsDeepLink(handle: string): string {
  return `sms:${handle}`;
}
