# Track F — notes

## Shared-file appends

| Prompt | File | What | Why it could not be track-local |
|---|---|---|---|
| 01 | — | none | The `f` cases in `gate.sh`, `check-ownership.sh` and `review-capture.sh` were authored by the user in `f529ffe`, not by this track. |

## Contract ambiguities found

| Prompt | Where | What disagreed |
|---|---|---|
| 01 | `POST /v1/heartbeat`, `contracts/openapi/boi-api.v1.yaml` | `digest_as_of` was `required` and non-nullable, but the grant heartbeat **precedes the first digest** by definition — so the one message this track exists to send was not expressible in the frozen contract. Raised before writing code; ruled on as **AMENDMENT-003** (required *and* nullable, `null` = "has never produced a digest"). Track E implements it in prompt `08`; this track encodes the amended shape in `GrantHeartbeat` and sends it through the unmodified `Uploader`. |
| 01 | `Uploader.HeartbeatUpload` | Declares `digest_as_of: String`, non-optional. It is Track E's file and this track may not edit it, so `GrantHeartbeat` exists alongside it to carry the nullable shape. **When Track E lands AMENDMENT-003 in `HeartbeatUpload`, `GrantHeartbeat` should collapse into it** and `GrantSignaller.send` becomes a one-line change. It is deliberately not a permanent second heartbeat type. |

## Prompt assumptions that were wrong

| Prompt | Assumption | What is actually true | What was done |
|---|---|---|---|
| 01 | Merge ordering: this branch was based on `track-e`, whose `Uploader.swift` did not exist on `main`, so `check-ownership.sh` would have attributed all of E's work to F and F could not have merged before E. | **Resolved, and the reasoning held.** Track E merged at `ef1b036` and this branch fast-forwarded onto it. The diff no longer carries E's work and the default `main` base is correct. | Recorded rather than deleted — the situation changed, the analysis did not. `BOI_BASE` is no longer needed; `bash scripts/check-ownership.sh f` passes against plain `main`. |
| 01 | DoD: "every `GrantWatcher` state renders a distinct screen — waiting, granted, relaunching, verified, failed". | `GrantWatcher.Event` has **four** cases and `verified`/`failed` are not among them, while `noDatabase` is and is absent from the list. The five failure paths in Scope are a different, larger set. | Ruled by the user: enumerate against **onboarding** states. `GrantStage` has 14 cases, is `CaseIterable`, and the suite asserts over all of them rather than over the five somebody remembered. |
| 01 | Scope: "grant given to the wrong entry" is a detectable failure path. | **It is not detectable.** A grant given to the wrong app and a user who never flipped anything both leave the probe `denied`, byte-identical. macOS exposes nothing that separates them. | Reported honestly as an **escalation, not a detection**: `.waitingStalled` names the two things worth checking and offers a way out, and claims no diagnosis. Confirmed as the right call by the user. |
| 01 | DoD: "a flapping grant produces at most one signal per minute". | Taken literally this **cuts against the track's own anchor** — a limiter that applies to the first `false→true` delays the one message the track exists to send. | Ruled by the user: the first transition fires immediately; the cap governs flaps thereafter. Both halves are asserted, each with its mutation. |
| 01 | TRACK.md fact: "the grant binds to the responsible process, which is the app bundle in `/Applications`". | **`~/Applications` holds the grant too.** This project's own `boi.log` records `~/Applications/Boi.app` holding Full Disk Access on 3 Aug and completing a sync of **94,897 messages**. The first implementation required `/Applications` exactly and would have told that user to move a working install — and moving the bundle is precisely what breaks a TCC grant. The criterion would have read green while the screen gave destructive advice. | Widened to both Applications folders, matched on the enclosing directory with symlinks resolved. `~/Downloads`, `/Volumes`, `/tmp` and Gatekeeper's randomized `AppTranslocation` paths are still rejected — translocation is the genuinely fatal one, since that path changes on every launch. Commit `ece7c33`. |

## Observations

**`GrantWatcher` may never fire `.granted` in the process that was running when the grant
was made, and if so the automatic relaunch never happens.** `FullDiskAccess` FINDING 4
states as an empirical fact that after granting, *"the identical query still returned
`authorization denied`… it only worked after the process was quit and reopened."*
`FullDiskAccess.probe()` is exactly that query, and `GrantWatcher.tick()` only emits
`.granted` when the probe succeeds. Read together, the pre-relaunch process cannot observe
the grant, so `.granted` never fires, so `Relauncher.relaunchNow()` is never called — and
the `deep link → poll → relaunch → verify` sequence stalls at `poll`, for exactly the
reason the sequence was designed to avoid.

Either the probe *can* observe the grant on current macOS (in which case FINDING 4 is
narrower than written), or the happy path silently depends on the user quitting Boi
themselves. **No test can settle this** — the grant cannot be scripted — which is why it
belongs to the one criterion reserved for the manual run. This track did not modify
`GrantWatcher` (it is Track E's), and it does not need to: `.waitingStalled` offers
"Quit and reopen Boi" after 30 seconds, so the user has a working exit under either
answer. But if the pessimistic reading is right, that button is the **primary** path
rather than a fallback, and the copy should eventually say so.

**`BoiKitTests` cannot import `BoiApp`.** `Package.swift` declares `BoiApp` as an
`executableTarget` and the test target depends on `BoiKit` only. So any judgement left in
`PermissionModel` — which stage a launch lands on, when waiting stops being honest, what
the user is told — is a judgement no test can read. This is why `GrantStage`,
`LaunchDisposition`, `GrantNarrator` and `GrantSignaller` all live in `BoiKit` and
`PermissionModel` is thin wiring over them. It was forced by the package layout rather
than chosen, and it is worth knowing before somebody "tidies" logic back into the view
model where the suite goes blind to it.

**An app bundle run from `/tmp` renders a 141×118 window off the left edge of the screen,
and it is not a code bug.** Chasing the first manual run, `Boi.app` built into
`/tmp/boi-a/app/` came up with no visible window despite `.frame(minWidth: 560, minHeight:
460)`. Building the **previous commit** and running it from the same place reproduced it
exactly (141×118 at X=-239), which is what established it was not this track's change.
Copying the identical bundle to `~/Applications` produced a correct 900×488 window on the
first launch.

So: **build the bundle, then run it from an Applications folder.** A `/tmp` build is fine
to compile and useless to look at. This matters because it is a trap that reads as "the
onboarding UI is broken" — the exact conclusion a reviewer would draw — when nothing is
wrong with it.

**A worktree needs its own `.venv`.** `FactExtractorTests` shells out to
`.venv/bin/python`, falling back to `/usr/bin/python3` — which on macOS is 3.9 and cannot
`from datetime import UTC`, so `DigestAmendment001Tests` fails with a fixture-unavailable
error that reads like a code defect. CONTRACTS § 5 already says worktrees share neither
untracked files nor installed dependencies; this is the concrete cost. Fixed locally with
`python3.12 -m venv .venv && .venv/bin/python -m pip install -e .`.

**The rate limiter had to be persisted, and that was not obvious from the prompt.** The
happy path *relaunches the process*. An in-memory limiter would signal the grant, restart,
come back with an empty memory and signal again — two heartbeats about one event roughly
two seconds apart, straight through a cap that reads as one-per-minute in every unit test
that does not model the relaunch. `GrantNarrator` persists to `grant-narrator.json` next
to the mirror, and the test that catches it is
`testTheLimitSurvivesTheRelaunchThatTheHappyPathPerforms`.

**Suppression has to converge, or the cloud is left believing a lie.** A limiter driven by
*edges* would suppress a revocation and then never see another edge, leaving the cloud
permanently believing a grant that no longer exists. `GrantNarrator.observe` is therefore
driven by the difference between the current state and the last **signalled** state, and
is called on every poll rather than only on a change.

## Runtime resources

CONTRACTS § 9 assigns Track A the Mac's resources and lists nothing for F. This track
allocates no ports and no database. It writes one new file, `grant-narrator.json`, into
the existing state directory alongside `heartbeat.json`. Tests use ephemeral
`NSTemporaryDirectory()` paths and a loopback server on an OS-assigned port.
