# Track F — Prompt 02: stop competing with macOS, then hand off to the thread

**Depends on:** 01. **Read first:** the manual-run findings below — they came from a real
grant on a real Mac and they overturn two assumptions in `01`.

## What the manual run settled

**1. `GrantWatcher` never observes the grant. The pessimistic reading of FINDING 4 is the
true one.** The app did not auto-advance. The relaunch is not a safety net — it is the
only path, and `.waitingStalled` is therefore the **primary** state, not a fallback
offered after 30 seconds of a counter the user is watching for nothing. One screenshot
shows `checked 43×`.

**2. macOS presents its own relaunch dialog, and Boi competes with it.** The system shows:

> **"Boi" will not have full disk access until it is quit.**
> You can choose to quit "Boi" now, or do it on your own later.
> [ Later ] [ **Quit & Reopen** ]

That dialog does the entire job. Boi's own UI appears at the same moment and, in the
user's words: *"Immediately after seeing the mac popup, Boi pops up as well, which is
friction and confusing… Boi shouldn't popup, it should just allow the quit & reopen."*

**3. It is not deterministic.** *"Then Boi gets access without quit and reopen sometimes."*
So the probe occasionally succeeds pre-relaunch and usually does not. Any design that
assumes either outcome is wrong half the time.

## Objective

Boi gets out of the system's way during the grant, and the last thing a user sees after a
successful scan is the way into the conversation — not a list of problems.

## Scope — part 1: get out of the way

- **When macOS offers Quit & Reopen, Boi shows nothing that competes with it.** No dialog,
  no modal, no state change that pulls focus. The system dialog is better than ours: it is
  authoritative, it is what the user already trusts, and it performs the relaunch.
- The window behind it should be *quiet and correct* — a line saying the relaunch is
  expected, so a user who picks **Later** understands what they deferred and how to
  resume.
- **Handle the non-deterministic case without changing the story.** If the probe does
  succeed pre-relaunch, proceed silently. Do not congratulate the user for skipping a
  step they did not know existed, and do not present a different flow than the one they
  were told about thirty seconds earlier.
- Re-order the states so the relaunch is the expected path. A 30-second timer before
  offering the only thing that works is 30 seconds of the product looking broken.

**Out of scope:** suppressing or replacing the system dialog. You cannot, and trying is
how apps end up fighting TCC.

## Scope — part 2: the handoff

Today the flow ends on *"Boi can see more than this"* — a health screen listing two
things that are wrong. It is honest, well-written, and **the wrong last impression**: the
user just granted full disk access and the reward is a list of problems.

The last screen is the handoff to the thread. Two states, one mechanism:

- **Paired** (a device token exists — the normal path under AMENDMENT-002, where the
  thread was opened before the app was installed): *"Boi is texting you now."* A button
  opens Messages to that conversation.
- **Unpaired** (direct download, or pairing never completed): the `sms:` deep link that
  creates the thread, with the prefilled body — the same link the confirmation page shows.

`sms:` opens an existing conversation or composes a new one, so it is one mechanism and
two copy variants. **Which state you are in is knowable** — ask the token store.

The health findings stay. They move below the handoff and stop being terminal. The
hierarchy is: what worked → what to do next → what could be better.

## Constraints

- **Owned:** `mac/Sources/BoiApp/**`, `GrantNarrator.swift`, your tests. Unchanged from `01`.
- The deep link's number is **per-user** — it comes from the registrar, not a constant.
  If the app cannot resolve it, say so plainly rather than rendering a broken link.
- `CONTRACTS.md` § 7 still applies. Nothing on any screen is message content.

## Definition of Done

- [ ] While the macOS relaunch dialog is up, Boi presents no competing dialog and does not
      take focus — asserted on the state machine, and confirmed in the manual run
- [ ] A user who chooses **Later** sees what they deferred and how to resume, and the poll
      state reflects it
- [ ] The relaunch path is the primary path in the state ordering; the pre-relaunch
      success case proceeds **silently** down the same story
- [ ] After a successful scan the terminal screen is the handoff, not the health list
- [ ] Paired and unpaired both render, asserted separately against the token store
- [ ] The deep link carries the user's assigned line and the prefilled body; an unresolvable
      line renders an honest message, never a malformed `sms:` URL
- [ ] Health findings render below the handoff and are not the last thing on screen
- [ ] `swift test --package-path mac` and `bash scripts/gate.sh f` green
- [ ] Every criterion names the mutation that breaks it, and the report shows it red
- [ ] **A second manual run**, screenshotted end to end — grant through handoff

## What to report

The screenshots, in order, plus the one sentence that matters: what the user sees at the
moment macOS asks them to quit.
