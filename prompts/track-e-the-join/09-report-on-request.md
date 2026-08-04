# Track E — Prompt 09: ask Boi for your report

**Depends on:** 08 — same files, so a real edge, not a numbering one. Do not batch.

## Context

Today Boi understands exactly two inbound things: a pairing code, and `1` or `2` to pick a
draft. **There is no way to ask for anything**, and the card exists only inside a
scheduled brief — so the earliest a new user can see their report is 8am tomorrow.

That is the wrong moment. They are most curious in the ninety seconds after their history
finishes loading, and we are asking them to sleep on it.

It also unblocks the kill test. Twenty people asking for their report and screenshotting
it is the same evidence as twenty receiving one, and it needs no scheduler and no waiting.

## Objective

After the first sync completes, Boi offers the report, and a templated text returns it.

## Scope

**In scope:**

- A `report` intent on inbound.
- After the first successful sync, Boi says the corpus size and prints the exact phrase to
  text back.
- The response: the card as an `image` block plus a short lead-in, and — when there are
  people waiting — the offer to draft.
- A per-user daily cache. This is the one path a user can trigger in a loop, and it
  renders a 1080×1920 PNG.

**Explicitly out of scope:**

- Any other intent. No help, no stop, no snooze. One intent.
- A language model anywhere in the matching. This stays a regex.

## Match loosely, advertise one phrase

Print one canonical phrase — **"send my friends report"** — and match generously around
it. Someone told to text that will type *"hi boi, i'd like to receive my friends report"*,
or just *"report"*. Matching on `report` with an optional `friend` catches all three;
exact-string matching fails the user who was polite.

Generous in one direction only: `1` and `2` must still mean draft selection, and a
six-digit string must still mean pairing. Order the matchers so the narrow ones win.

## The refusal case

Below the ranking bar the renderer returns a **refusal** card. The standing rule is that a
refusal card is never attached to a *scheduled* brief, because daily it becomes a
reproach.

**On request it is fine, and it must say what would change it** — how much history is
needed, or that the corpus is thin and why. A user who asked a direct question gets a
direct answer.

## Definition of Done

- [ ] After the first sync, Boi sends the corpus size and the exact phrase to text back
- [ ] The canonical phrase returns a brief containing an `image` block — asserted over what
      the **channel received**, not over a stored record
- [ ] Three phrasings — the canonical one, a polite long form, and the bare word `report` —
      all match; three near-misses that should not match are asserted not to
- [ ] `1`, `2`, and a six-digit code still route to their existing handlers, asserted after
      the new matcher exists
- [ ] A thin corpus returns the refusal card **and a line naming what would change it**
- [ ] A second request the same day serves the cached image and says when it next changes;
      asserted that the renderer ran once
- [ ] A request from an unpaired number is handled without leaking whether that number is
      known to us
- [ ] `bash scripts/gate.sh e` green, and every criterion names the mutation that breaks it

## What to report

The card, as the user receives it, in the thread. That artifact is the kill test's
input — twenty of those screenshots is the decision the whole project is waiting on.
