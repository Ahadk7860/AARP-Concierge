# Track E — Prompt 08: the user opens the thread

**Depends on:** 07. **Read first:** `prompts/AMENDMENT-002-the-user-goes-first.md`.

## Context

`BOI_ARCHITECTURE.md` § 4.1 says Boi texts first and calls it *"not optional… a
correctness fix, not a growth hack."* The failure mode it names is real — iOS **Filter
Unknown Senders** puts non-contacts in a tab with no notification. The remedy is
backwards, and Apple's own documentation is why:

> **"If you respond to a message from an unknown sender, that does not automatically mark
> the sender as known or move the message to your conversation list."**

So our sequence — Boi first, user replies with a code — leaves Boi filtered. Whereas
*"anyone you haven't previously interacted with"* means a user who **initiates** has
already made Boi known.

The tell is in our own copy: `welcome.ts` says *"save me so i don't end up in your
filtered messages."* We are asking the user to fix a problem we created.

## Before you write any code

**The five-minute test is the user's to run and its shape changed** — read the amendment's
current version. It is now sent **from Messages on a Mac**, not from the phone, because
that is the flow. It also returns a second answer: which handle Apple sends from.

Do not start until the user reports both observations. If the filter result fails, stop —
the fallback is the old flow *plus* the deep link, and that is the user's call.

## Objective

A user signs up, taps one link, sends one prefilled message, and is paired — with no
contact to save and no code to type.

## Scope

**In scope:**

- Register the user with the transport at signup — **both the phone and the email**, because
  Messages on a Mac frequently sends from the Apple Account email and that failure is
  silent. Resolve **their assigned line**; the shared pool means the number differs per
  recipient, so the link cannot be a constant.
- **Boi's first reply carries the Mac app download link.** This is the ordering the
  amendment turns on: Boi is useful before it asks for full disk access.
- A confirmation page whose `sms:` link targets that line and carries a **prefilled body
  containing a pairing token**.
- Inbound: a first message carrying a valid token pairs the sender and returns the device
  token, replacing the 6-digit exchange.
- The contact card moves to **Boi's first reply**.
- The Mac app no longer displays a code to type. It receives its token from the pairing
  that already happened.

**Explicitly out of scope:**

- The on-demand report. That is `09`.
- Spectrum itself. `10`. Build against `StubChannel` and the mock, as every other prompt has.
- Redesigning the signup page beyond the link and its copy.

## Constraints

- **Paths:** `cloud/api/src/{welcome.ts,routes/signup.ts}`, `cloud/brief/src/inbound.ts`,
  `cloud/channel/`, and the Mac's pairing surface. Grants are in place.
- The token is single-use, expiring, and bound to one `user_id` — every property the
  6-digit code already has. **Do not weaken any of them because the token is now
  invisible to the user.** An opaque token that never expires is worse than a visible code
  that does.
- Never log the token. It is a bearer credential in a URL.

## The trap

A prefilled `sms:` body is **user-editable**. They can delete it, mangle it, or send an
empty message. Handle all three: an inbound with no recognisable token from a number that
matches a pending signup gets a friendly re-prompt, not silence and not an error.

And the body is **visible in the thread forever**. Whatever the token looks like is
something the user reads every time they scroll up. Make it short and unembarrassing.

## Definition of Done

- [ ] The user's two observations are recorded in `NOTES.md`: filter placement, and which
      handle Apple sent from
- [ ] **Both** the phone and the email are registered with the transport at signup, and an
      inbound from either resolves to the same user — asserted for both
- [ ] Boi's first reply contains the Mac app download link
- [ ] Signup registers the user with the transport and resolves their assigned line before
      the confirmation page renders — asserted, including the failure path when the
      transport is unreachable
- [ ] The confirmation page contains a valid `sms:` link to **that user's** line with a
      prefilled body, asserted against a seeded user, not a constant
- [ ] A first inbound carrying a valid token pairs the user and returns a device token
- [ ] Single use, expiry, and binding to one `user_id` each asserted, with a controlled
      clock — the same three tests the 6-digit code has
- [ ] An edited, emptied, or mangled body from a pending-signup number produces a
      re-prompt, asserted for all three
- [ ] Boi's first reply carries the contact card block
- [ ] The token appears in no log — grep a full run, as prompt `01` does for message bodies
- [ ] `npm run e2e` green with the new flow; `bash scripts/gate.sh e` green
- [ ] Every criterion names the mutation that breaks it, and the report shows it red
