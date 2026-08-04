# Track F — Prompt 01: the user is in System Settings and can see nothing

**Depends on:** nothing. **Read first:** `TRACK.md`, `prompts/CONTRACTS.md`,
`prompts/AMENDMENT-002-the-user-goes-first.md`.

## Context

Today the app asks for Full Disk Access, opens a deep link, and shows a spinner while
`GrantWatcher` polls. The user is now in a different application, looking at a list of
apps, with no idea whether they have done the right thing. If they get it wrong, nothing
tells them. If they get it right, the app relaunches and they were never told why.

This is the highest-drop-off moment in the product and it is currently silent.

Under AMENDMENT-002 the iMessage thread **already exists** by the time the app is
installed — the user opened it, and Boi replied with the download link. So the app is no
longer the only surface available. **The grant can be narrated in the thread**, on the
phone in their hand, while they work on the Mac.

## Objective

From download to first sync, the user is never more than one screen or one message away
from knowing exactly what is happening and what to do next.

## Scope

**In scope:**

- The onboarding sequence in `BoiApp`: what the user sees at each state of
  `GrantWatcher` — waiting, granted, relaunching, verified, failed.
- **The grant-state signal.** When FDA flips, fire a heartbeat immediately rather than
  waiting for the next scheduled sync. `POST /v1/heartbeat` already carries `fda_granted`
  and is frozen; you are calling the existing `Uploader`, not changing it.
- `GrantNarrator`: the small piece that decides *when* a state change is worth telling the
  cloud about, and rate-limits it. Not what the message says — that is the cloud's copy.
- The failure paths, each with a specific remedy: bundle not in `/Applications`, grant
  given to the wrong entry, user backs out, relaunch budget exceeded, still denied after
  relaunch.

**Explicitly out of scope:**

- The message copy Boi sends. Cloud-side, Track E.
- Signup, the `sms:` link, pairing. Cloud-side, Track E.
- Redesigning the app's visual language beyond these states.
- Notarization, Developer ID, Sparkle. Still deferred.

## Constraints

- **Owned:** `mac/Sources/BoiApp/**`, `mac/Sources/BoiKit/GrantNarrator.swift`, the two new
  test files.
- **You may call `Uploader` and `GrantWatcher`. You may not modify them.** They are Track
  E's and they are merged and tested. A needed change is a `NOTES.md` finding.
- No `Package.swift` edit — SwiftPM globs, and that file is shared.
- `CONTRACTS.md` § 7: **no message content in any log, test, commit or report.** This
  track never touches message bodies, so any appearance of one is a bug.

## The trap

**A test that asserts the app called `GrantWatcher` is not a test of this prompt.** The
subject is what the user is told, and when. Assert on the rendered state and on the
heartbeat that left the machine — not on an internal call count.

And the state machine has a shape that hides bugs: **the happy path relaunches the
process**, so a naive test loses its subject halfway through. Drive `GrantWatcher`'s
states directly with a controlled clock rather than performing a real grant, and keep one
end-to-end manual observation for the report.

## Definition of Done

- [ ] Every `GrantWatcher` state renders a distinct screen naming what to do next —
      enumerated, asserted, no state falling through to a generic spinner
- [ ] The poll count is visible, so a waiting user can see the app is alive
- [ ] FDA flipping false→true fires a heartbeat **within one poll interval**, asserted
      against a stub server — not on the next scheduled sync
- [ ] That heartbeat carries `fda_granted: true` and validates against the frozen
      `POST /v1/heartbeat` schema
- [ ] `GrantNarrator` rate-limits: a flapping grant produces at most one signal per minute,
      on a controlled clock
- [ ] Each of the five failure paths renders its own remedy, asserted separately. **A
      generic "something went wrong" fails this criterion**
- [ ] Bundle-not-in-`/Applications` is detected *before* the deep link is shown, not after
      the grant fails
- [ ] Relaunch-budget-exceeded is distinguishable from still-denied in both the UI and the
      log
- [ ] `swift test --package-path mac` green, including every pre-existing test
- [ ] `bash scripts/gate.sh f` green; ownership holds
- [ ] Every criterion names the mutation that breaks it, and the report shows it red
- [ ] **One real grant, performed by hand**, with a screenshot of each state. This is the
      one thing no test can produce

## What to report

The screenshots, in order, as a user would see them. Then the heartbeat that left the
machine at the moment of the grant.
