# Track A — Prompt 07: The .app: permissions that are engineered, not documented

**Depends on:** 06

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes everything before it. This is the last prompt in the track and the one the
architecture warns about: the iMessage read feature is 2–4 days of work, while the
delivery vehicle — signing, notarization, onboarding UX, annual macOS compatibility — is
about 5% of the code and 25–35% of ongoing engineering. **Budget it as a product, not a
feature.**

The Full Disk Access grant cannot be scripted: no `tccutil` grant exists and `TCC.db` is
SIP-protected. A human clicks. What you control is everything around the click.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A launchable `Boi.app` takes a user from first open to a written digest, including the Full Disk Access grant, without them ever having to find the app again.

## Scope

**In scope:**

- A SwiftUI app bundle wrapping `BoiKit`. **All privileged I/O happens inside the bundle** — CLI executables dropped off the FDA list in macOS 26.1–26.2.
- Consent screen naming, in plain language, that other people's messages are processed.
- The FDA screen: deep-link to the pane, **poll for the grant every 500ms**, and the instant it appears **relaunch the app automatically**. Never make the user find the app again — macOS offers 'Quit & Reopen' and users dismiss it.
- Live status in the window: a checkmark that flips the moment the toggle flips. Not knowing whether it worked is the single biggest reason people abandon this screen.
- Detect the already-granted case and skip the screen entirely on reinstall.
- The health check screen from `06`, rendered, with its three branches.
- A `LaunchAgent` via `SMAppService.agent`, plist inside `Contents/Library/LaunchAgents/`, invoking **the main app binary with `--sync`**. Never a separate helper — TCC is per-responsible-process and children do not inherit, so a helper would need its own grant the user has no idea how to give.
- `StartInterval` around 1800s with an idempotent guard ('have I completed a run in the last N hours?'), **not** `StartCalendarInterval` — it degrades gracefully across unpredictable laptop opens. Take `caffeinate -i -w $$` for the duration of a run.
- `FullDiskAccessProvider` conforming to the frozen `LocalStoreProvider` protocol, so the later swap to scoped bookmarks is a config change rather than a rewrite.

**Explicitly out of scope for this prompt:**

- Notarization, Developer ID signing, and Sparkle. These cannot be verified against the foundation and need a paid Apple Developer account — they are the round after this one. Say so in `NOTES.md`.
- The pairing code exchange and any network call. Track D owns that endpoint and it is not wired in this round.
- Scoped security bookmarks. FDA is the MVP; the protocol is what makes the swap cheap later.
- The app icon and visual design beyond what is needed to be legible.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`. Do not add a second executable target that reads `chat.db`; a bare helper binary cannot hold the grant.
- **Contracts to code against verbatim:** `LocalStoreProvider` and `DataSource` — frozen in `mac/Sources/BoiKit/Contracts.swift`.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `Boi.app` builds and launches. State the exact build command in your report.
- [ ] **With FDA already granted:** launching the app skips the permission screen, runs a scan, and writes a valid digest — `python3 scripts/validate_fixtures.py digest.v1 <path>` exits zero
- [ ] **With FDA revoked** (`tccutil reset SystemPolicyAllFiles <bundle-id>`): the app shows the permission screen, the deep link opens the correct pane, and after you grant it the app **relaunches itself within 2 seconds without you touching it**. Record this as a screen recording or a timestamped log.
- [ ] The status checkmark flips within 1 second of the toggle flipping — visible in the same recording
- [ ] The LaunchAgent is registered via `SMAppService.agent` and `launchctl list | grep -i boi` shows it
- [ ] **A manual `--sync` invocation of the app binary produces an updated digest**, proving the agent's entry point works: run the exact command the plist specifies
- [ ] The plist lives inside `Contents/Library/LaunchAgents/` and specifies the **main app binary**, not a helper — paste the plist
- [ ] `grep -rn 'LaunchDaemon' mac/` returns no matches
- [ ] The idempotent guard works: invoking `--sync` twice within the interval performs one run and logs a skip
- [ ] Existing tests still pass: `swift test --package-path mac` exits zero
- [ ] Lint passes: `swift build --package-path mac -Xswiftc -warnings-as-errors` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh a` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

> Use `git diff --name-only main...HEAD`, not `git status`. After the mandated commit
> `git status` is empty and the check passes silently — leaving the entire ownership
> model unguarded. `scripts/check-ownership.sh` does this correctly.

Every criterion above is checkable using **only the foundation stubs and this track's
own code.** Nothing here requires another track's real implementation.

## Self-verification — do this before reporting

1. Run every item in the Definition of Done yourself.
2. If any item fails, fix it and run the whole checklist again.
3. Repeat until every item passes, or until you are genuinely blocked in a way you
   cannot resolve within this prompt's scope.
4. Only then report.

### Frozen anchors

You may not modify, skip, delete, or weaken any existing test, assertion, lint rule,
or type constraint in order to pass this checklist. You may not lower a threshold, add
an exception, loosen a type, or mark a test pending or skipped.

If a check must change for a legitimate reason, stop. Record it in `NOTES.md` under
`## Deviations from the plan`, and report it. Do not change it and continue.

**A green checklist bought by weakening a check is a failure reported as a success.**

A fresh-context reviewer will read the full diff specifically for bent anchors when
this track completes.

Summary: **a green checklist bought by weakening a check is a failure reported as a
success.** You are grading your own work here, and the easiest way to turn a criterion
green is to weaken the criterion. A fresh-context reviewer reads the full diff for bent
anchors when this track completes.

## Evidence to include in your report

Claims are not accepted; artifacts are. Produce:

- the build command and its output
- a screen recording or timestamped log of the revoke → grant → auto-relaunch sequence
- the LaunchAgent plist, verbatim
- `launchctl list | grep -i boi`
- validator output for the digest the app produced
- the `NOTES.md` entry recording that notarization, signing and Sparkle are deferred
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 07 app-bundle — <what changed>"
```

Commit even if the next prompt continues the same file. Every stage gets a commit.

## Stop

After committing, **stop and report.** Do not begin the next prompt.

> **Do not merge this branch. Do not open a pull request. Do not touch the base
> branch. Stop and report when the track is done.** Full rule:
> `prompts/MERGE-POLICY.md`.

If you are blocked rather than done: commit what works with the blocker named in the
message, write it into `NOTES.md` under `## Blockers`, and report. A reported blocker
is a legitimate outcome. A false green is not.

Wait for the user's go-ahead.
