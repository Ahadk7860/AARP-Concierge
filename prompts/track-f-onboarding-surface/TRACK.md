# Track F — the onboarding surface

**Runs in parallel with Track E, in its own worktree.** The first genuinely parallel track
since the original four merged, and it exists because Track E is one session working
through a serial chain in `cloud/` while the highest-drop-off surface in the product —
the Mac app's first ninety seconds — sits untouched.

## Why this is safe to run alongside E

- **`mac/Sources/BoiApp/**` is owned by nobody.** Track E owns `BoiCLI/main.swift`,
  `SyncRun.swift`, the uploader, and the AMENDMENT-001 grants. None of them is here.
- **SwiftPM globs sources**, so a new file in `BoiApp/` needs no `Package.swift` edit —
  which would have been a shared-file collision.
- **Different toolchain.** `swift test` versus E's `vitest` and `pytest`.
- **No new contract.** The one thing this track needs from the cloud already exists and is
  frozen: `POST /v1/heartbeat` accepts `fda_granted`. Track F fires it; Track E reacts to
  the false→true transition by texting the user. Neither edits the other's file.

## What it builds

Read `prompts/AMENDMENT-002-the-user-goes-first.md` first. The ordering it fixes is the
whole reason this track exists:

```
sign up on the Mac -> sms: opens Messages ON THE MAC -> user sends
  -> Boi replies with the download link   <- Boi is useful before it asks
  -> install -> FDA -> sync -> the report arrives in the thread
```

This track owns everything from "the download finishes" to "the first sync completes,"
and its job is that the Full Disk Access grant — the single highest-friction moment in
the product — stops being a spinner and becomes a conversation.

## Owned paths

- `mac/Sources/BoiApp/**`
- `mac/Sources/BoiKit/GrantNarrator.swift` (new)
- `mac/Tests/BoiKitTests/GrantNarratorTests.swift`, `OnboardingTests.swift` (new)

**Forbidden:** all of `cloud/`, all of `intelligence/`, every other file in
`mac/Sources/BoiKit/`, and `mac/Package.swift`. You may **call** `Uploader` and
`GrantWatcher`; you may not modify them. If one needs a change, that is a finding for
`NOTES.md`, not an edit.

## The anchor

> **The grant is the product's cliff edge, and a user standing on it can see nothing.**

Every criterion in this track is about what the user knows while they are in System
Settings. An implementation that works and says nothing has failed.

## Facts already established, so you do not rediscover them

- **macOS will not apply a TCC grant to a running process.** The sequence is
  `deep link → poll → relaunch → verify`. Poll-then-proceed waits forever for a permission
  this process can never observe. `GrantWatcher` implements it; use it.
- **The grant binds to the responsible process**, which is the app bundle — not a helper,
  not a child. The bundle must be in `/Applications`.
- `GrantWatcher` polls every 500ms and carries a poll count so the UI can prove it is
  alive. `FullDiskAccess.relaunchBudget` is 2.0s.
- **Never a LaunchDaemon.** The LaunchAgent invokes the main app binary with `--sync`.

## Reporting

The three-pass review in `prompts/TRACK-REVIEW.md`. Same gate: `bash scripts/gate.sh f`.
Every criterion names the mutation that breaks it, and the report shows it red.
