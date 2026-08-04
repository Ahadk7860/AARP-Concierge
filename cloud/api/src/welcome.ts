// The onboarding surface: the first two messages, and the link that starts the thread.
//
// **AMENDMENT-002 INVERTED THIS FILE.** It used to say that Boi sends first, and that
// this was a correctness fix rather than a growth hack, because iOS *Filter Unknown
// Senders* routes messages from non-contacts into a tab with no notification.
//
// The failure mode was real and the remedy was backwards. Apple: *"if you respond to a
// message from an unknown sender, that does not automatically mark the sender as known"*
// — so Boi-first left Boi filtered even after the user replied with their code, and it
// took three replies to clear, which is most of onboarding conducted in a tab nobody
// opens. Whereas *"anyone you haven't previously interacted with"* means a user who
// INITIATES has already made Boi known.
//
// Tested 4 Aug on a clean device by somebody who had never texted the handle, with the
// filter on: the user sent first and the reply landed in the main conversation list. The
// second observation is the one that settles it — when the LINE initiates to somebody who
// has not written first, iMessage attaches the spam-report affordance. The old design was
// walking into a "report junk" button under Boi's first words, every single time.
//
// The tell was in this file's own copy: "save me so i don't end up in your filtered
// messages" was asking the user to fix a problem we created by going first.
//
// So: the user opens the thread from a deep link, and the contact card — which used to be
// the whole mechanism — moves to Boi's first REPLY, where it is a courtesy rather than a
// mitigation.

import { randomInt } from "node:crypto";

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
 * The cold open. **RETIRED by AMENDMENT-002 and deliberately not deleted.**
 *
 * Nothing sends this any more — a line that initiates to somebody who has not written
 * first gets the spam-report affordance attached, which is worse than the filtered tab it
 * was meant to avoid.
 *
 * It stays because `contracts/fixtures/outbound/first_contact_card.json` is a FROZEN
 * fixture and this function is what conforms to it. Deleting the function to tidy up
 * would leave a frozen fixture with no producer — a shape nothing in the repo can build
 * and nothing can check. It is also the fallback the amendment names: if the filter
 * result had failed, the flow would have been the old one PLUS the deep link.
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

/**
 * The pairing secret under AMENDMENT-002: `boi-4f2a91`.
 *
 * Nobody types this — it arrives prefilled in the deep link's body — so its shape is
 * chosen for the one property the six-digit code never needed: **it lives in the thread
 * forever and the user rereads it every time they scroll up.** It has to look like
 * plumbing rather than like a password they were supposed to guard. A user who believes
 * they leaked a credential has had a bad experience whether or not they did.
 *
 * 24 bits, and entropy is deliberately not what protects it: pairing by inbound requires
 * the message to arrive from a handle registered to that user, and an attacker who
 * controls that handle has already won. Expiry and single use are the guards, unchanged
 * from the code they replace.
 *
 * Lives here rather than in `cloud/db/src/ids.ts` because that file is not this track's;
 * the shape is an onboarding-surface decision either way.
 */
export function newPairingToken(): string {
  return `boi-${randomInt(0, 0x100_0000).toString(16).padStart(6, "0")}`;
}

/** Either form: `POST /v1/pair` still takes a code, the thread now carries a token. */
export const PAIRING_SECRET = /^(?:[0-9]{6}|boi-[0-9a-f]{6})$/;

/**
 * The deep link the confirmation page renders: that user's line, and a prefilled body.
 *
 * **The handle is a parameter and must never be a constant.** The transport's pool is
 * shared, so the number differs per recipient; a link built from one hard-coded handle
 * would open a thread with a line that is not theirs, and the message would go to a
 * stranger's conversation or nowhere.
 *
 * `&body=` rather than `?body=`: Apple's own documentation uses the ampersand form for
 * `sms:` and both iOS and macOS Messages accept it. `sms:` rather than `imessage:` for
 * the reason it always was — `imessage:` fails outright on a handle Apple has not
 * registered, which is the handle-mismatch case and the one where a dead link is least
 * recoverable.
 */
export function pairingDeepLink(input: { handle: string; token: string }): string {
  return `sms:${input.handle}&body=${encodeURIComponent(input.token)}`;
}

/**
 * The pairing code, as a SECOND message. **Retired with the cold open**, and kept for the
 * same reason: `POST /v1/pair` still accepts a six-digit code, Track F's pairing surface
 * is mid-flight against it, and the amendment's own fallback is the old flow plus the
 * deep link. Nothing on the AMENDMENT-002 path calls it.
 *
 * Separate from the welcome on purpose: `first_contact_card.json` is a frozen fixture
 * and the welcome must keep matching it exactly. A code appended to that text would
 * break conformance for a cosmetic reason.
 *
 * This exists because the code previously left the building only as an
 * `x-boi-pairing-code` HTTP response header — a header on a page the user is not
 * looking at, on a request their browser made. The frozen welcome tells them to text
 * their pairing code; nothing had ever given them one. That is § 4.1's failure mode
 * from the other direction: the product appearing broken at the moment it is supposed
 * to feel like magic.
 */
export function pairingCodeMessage(userId: string, code: string): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: userId,
    // Keyed on the code, so re-issuing sends a new message and a retry of the same
    // issue does not.
    idempotency_key: `paircode-${userId}-${code}`,
    blocks: [
      {
        type: "text",
        text:
          `your pairing code is ${code} — type it into the Mac app, ` +
          `or text it back to me once the app is set up. it expires in 10 minutes.`,
      },
    ],
    reply_to_message_id: null,
  };
}
