# Track F — notes

## Shared-file appends

| Prompt | File | What | Why it could not be track-local |
|---|---|---|---|
| 01 | — | none | The `f` cases in `gate.sh`, `check-ownership.sh` and `review-capture.sh` were authored by the user in `f529ffe`, not by this track. |
| 02 | `scripts/gate.sh` | Appended a **test census** block: prints the count the runner discovers, the count declared at `HEAD`, and the delta against `HEAD~1`. Swift tracks (`a`, `f`) only — a no-op elsewhere rather than a guess at another runner's output format. | The gate is the only place the number is visible at the moment a claim is made about a commit. Putting it in a track-local script would mean the one report that matters never shows it. Append only: no existing line changed, and `check-ownership.sh f` passes. |

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

## Prompt 02 — what the manual run changed

| Prompt | Assumption in `01` | What the manual run showed | What was done |
|---|---|---|---|
| 02 | `GrantWatcher` might observe the grant; the relaunch is a safety net. | **It never does.** The pessimistic reading of FINDING 4 is the true one — `01`'s NOTES flagged this as unresolvable by test and the run settled it. | The automatic relaunch is **removed**. Relaunch is user-initiated only and offered from the *first* waiting screen. `.waitingStalled` is no longer where it first appears. |
| 02 | An acknowledgement screen at the moment of the grant is reassuring. | macOS puts up its own *"Boi will not have full disk access until it is quit"* dialog at that instant, and Boi appearing alongside it was *"friction and confusing"*. | The `.granted` stage is **deleted**. There is no stage to show while the system dialog is up; the user stays on `waiting`, which is quiet and explains what the dialog is asking. |
| 02 | The pre-relaunch probe either works or does not. | *"Then Boi gets access without quit and reopen sometimes."* Non-deterministic. | The success path proceeds **silently** to `syncing` — no congratulation, no different flow from the one the user was reading thirty seconds earlier. |
| 02 | Ending on the health screen is fine because it is honest. | It is honest and it is the wrong last impression: the reward for granting full disk access was a list of two things that are wrong. | `.handoff` is the terminal stage. Health findings render below it under a quieter heading. |

**The Later case is undetectable, and the screen has to answer it anyway.** A user who
flipped the switch and chose **Later** leaves exactly the same `denied` probe as a user who
never flipped anything — there is no API that separates them, the same shape of limit as
the wrong-entry case in `01`. So `waiting`'s copy names the dialog, names both buttons, and
tells the deferred user that the button below does the same job whenever they are ready.
That is the whole remedy, and it is on screen before it is needed rather than after.

**The counter was making a promise the product could not keep.** `01` rendered
*"Waiting for the switch… (checked 43×)"*, which reads as *any moment now*. Nothing was
ever going to notice. The title now names the restart, and the count stays only as proof
the app is alive.

## Contract gaps opened by prompt 02

**The Mac cannot resolve the user's assigned line, and there is no Mac-side client for it.**
The registrar lives entirely in `cloud/api/src/` — `git grep` over `mac/Sources` on
`track-e` finds nothing. The line is **per-user** (shared pool), so a constant would open a
thread with somebody else's number, and the prompt is explicit that an unresolvable line
must render an honest message rather than a broken link. Handled the same way as the device
token in `01`: `assignedLine` and `pairingToken` are injected, read from
`BOI_ASSIGNED_LINE` / `BOI_PAIRING_TOKEN`, and `ThreadHandoff.lineUnresolved` renders the
plain-language message when absent. **This is a seam, not a resting place** — a Mac-side
pairing/registrar client is still missing, and it is the same gap `01` recorded.

**The link format is duplicated across the language boundary.** `cloud/api/src/welcome.ts`
builds `sms:${handle}&body=${encodeURIComponent(token)}`; `ThreadHandoff.link` reproduces
it in Swift. Nothing checks the two agree — `&body=` versus `?body=` is a one-character
divergence that opens Messages with an empty body and silently loses the pairing token, and
both sides would still pass their own tests. It is not a shape `contracts/schema/` covers.
Worth a fixture or a shared constant; recorded rather than solved because the fix is a
contract change and this track does not make those.

## A test whose fixtures never reach the boundary it claims to defend

`testEveryProducedLinkIsAParseableURL` asserted that every link `ThreadHandoff` produces
survives `URL(string:)`. The assertion was real. **Every handle it passed in was already
safe** — `+15551234567` and `boi@example.com` — so loosening `isUsable` to permit `/`, `<`,
`>` and quotes changed nothing it could see. The mutation came back **GREEN**: the test
named a boundary and never went near it.

This is worth naming as a shape, because it is invisible in review. The test reads
correctly, the assertion is the right assertion, the name describes a real property, and it
passes for the right-looking reason. What is missing is not in the test body at all — it is
in the fixtures, which stop short of the edge. Reviewing the assertion tells you nothing;
only a mutation does, and only a mutation that moves *the boundary itself* rather than the
logic around it.

The fix was to push the inputs to the edge — `+1555/x`, `a<b>@c.com`, `a"b@c.com`,
`+1555?x=1` — in the test that owns the rejection rule, and to retarget the mutation there.
Fixed in `2b726b8`.

**The general form:** when a test defends a validator, at least one fixture has to be a
value the validator is the only thing rejecting. If every input would pass anyway, the
validator could be deleted and the suite would not notice.

## A green suite with the wrong number of tests is not green

Twice in this track a revert-based mutation harness ran `git checkout` over an
**uncommitted** file and destroyed its own subject — the install-location fix in `01`, the
cross-language test in `02`. The second time, the suite came back **257 where 258 was
expected**, and the only thing that caught it was the arithmetic not matching.

**Every mechanism in this project reports a vanished test as a pass.** `swift test` exits
zero because the tests that remain all pass. `gate.sh` checks that the suite compiles and
that no suite was silently *skipped* — but a suite that is simply *smaller* than it was
trips neither. There is no failure signal anywhere, because nothing failed. The test is
just gone.

This is the same family as the two failures that named the other checks — a suite that
could not compile reporting zero failures, and vitest reporting a skipped file as a pass —
and it is the one nobody had a check for. It is also strictly worse than those two, because
the others leave evidence in the output and this leaves none at all.

Two things came out of it:

- **The rule: commit before mutating.** A revert-based harness is only safe over committed
  state; over uncommitted work `git checkout` is not a revert, it is a delete.
- **The transferable part is not the rule, it is the habit.** What saved it was expecting a
  number and checking when the number disagreed, rather than accepting a green. The rule
  prevents one specific accident; the habit catches the whole class.

Recorded in `gate.sh` as a **census** rather than a gate: discovered count, declared count,
and the delta since `HEAD~1`. Deliberately not enforced — deleting a superseded test is
legitimate, and this track did exactly that when prompt `02` overturned two of prompt
`01`'s assertions. A check that goes red on a legitimate action is a check people learn to
route around. Printing the delta makes a shrink something a reader has to account for
instead of something nobody can see.

## Two languages computing the same string is a contract — and this is the fourth one

`ThreadHandoff.link` (Swift) and `pairingDeepLink` (TypeScript, `cloud/api/src/welcome.ts`)
both build `sms:<handle>&body=<encoded token>`. Nothing checks they agree. `&body=` versus
`?body=` is one character, it opens Messages with an empty body, the pairing token is
silently lost, and **both sides pass their own tests**.

That makes four cross-language seams in this project, and the two that held are the two
where the **algorithm** was pinned rather than the shape:

| Seam | Outcome | Why |
|---|---|---|
| `contact_id` | **Held** | `CONTRACTS.md` § 3 pins the algorithm — `HMAC(user_salt, normalized_handle)` — and `DigestTests.swift:938` computes both sides independently and compares, failing if nothing matched at all rather than silently comparing an empty set. |
| Fact vocabulary | **Held** | One side is *generated* from the other by `scripts/generate_fact_vocabulary.py`, and `FactsTests.testVocabularyMatchesPython` re-reads the Python sets at test time — so the generator cannot go stale unnoticed. |
| Heartbeat shape | **Diverged** | `Heartbeat` (Mac) and the frozen `POST /v1/heartbeat` schema had no overlapping required fields. Found by Track E only when it tried to post one; caught by a schema, not by a test. |
| `sms:` link format | **Pinned — paired path both-sides, unpaired path pending** | `&body=` confirmed on a real Mac and written into `CONTRACTS.md` by the user, with `testTheSwiftAndTypeScriptDeepLinksAgree` cited as the enforcement. **Read "pinned" precisely:** the test runs both languages today only for the *paired* link, because `pairingDeepLink` is Track E's prompt `08` and is not on this branch. The `&body=` separator itself is currently pinned by the Swift side, the spec, and the device observation — **not yet by two languages agreeing.** It becomes cross-verified automatically when `08` merges; the test enumerates what TypeScript exports and needs no edit. |

The lesson the first two teach and the last two prove: **specifying the shape is not enough
— the algorithm has to be specified, and a test has to build both sides from scratch.** A
schema catches a wrong field name. It does not catch two correct implementations of two
different readings of the same sentence, which is what a separator is.

**Resolved by the second manual run: `&body=` is empirically correct.** The deep link
opened Messages with the number and the body prefilled. (`open --env` was needed to pass
`BOI_ASSIGNED_LINE` / `BOI_PAIRING_TOKEN` through to a bundled app — `open -a` does not
forward the caller's environment.) The green bubble in that run was the placeholder number
having no iMessage registration, so macOS fell back to SMS; not a code path.

The Swift side needed no change — it already built `&body=`, and that is now confirmed
rather than assumed.

**Pinned in `OnboardingTests.testTheSwiftAndTypeScriptDeepLinksAgree`**, built in the
`contact_id` shape: both sides computed from scratch and compared, never one side asserted
against a literal somebody typed. Node runs the real `.ts` through type stripping
(`--experimental-strip-types`), so it needs no `npm install` — which matters here, because
a worktree shares no untracked dependencies and **a test nobody can run is a test nobody
runs.** It carries the non-vacuity guard that made `contact_id` hold: a comparison over an
empty set is indistinguishable from one that succeeded.

Today it compares the **paired** path only. `pairingDeepLink` is Track E's prompt `08` and
is not on this branch — my `welcome.ts` exports `smsDeepLink` and nothing else. The test
enumerates what the TypeScript side exports, so it extends to the unpaired path **with no
edit here** the moment `08` merges. Until then the `&body=` separator is pinned on the
Swift side and by the empirical run, not yet by both languages.

**Still the user's to write: the format in `CONTRACTS.md`.** That file is frozen to this
track (§ 8), so the specification half of the pin is an amendment, not something this
track can land.

## The false claim, and why deleting beat softening — fixed in `16a6760`

`ThreadHandoff.lineUnresolved` rendered *"Boi will still text you — this window just cannot
open the thread for you."* **True when paired, false when not.** An unpaired user with an
unresolvable line has no thread and no completed pairing, so nothing was going to text
them.

`lineUnresolved` collapses two genuinely different situations — *we know who you are but
not which line* and *you were never paired* — and pairing is knowable from the token store.
That makes it unlike the Later case in prompt `02`: **not a limit of the platform, a
distinction this code declined to make.**

**Deleted rather than softened.** Hedging it — "Boi may still text you" — would have
preserved a claim about the thing this state specifically cannot determine. The copy now
says the two things it knows (this Mac has not been told which number is yours; this window
therefore cannot open the thread) and nothing about future contact. Prompt `03` splits the
state and gives each half accurate copy.

**It shipped false because it was unreachable by tests.** The string lived in
`OnboardingView.swift`, in the executable target `BoiKitTests` cannot import — the exact
constraint that put `GrantStage` in `BoiKit` in prompt `01`, applied inconsistently one
file over. Moved to `ThreadHandoff.copy` and now asserted. The lesson generalises past this
bug: **user-facing copy that no test can read is copy that can be false for as long as
nobody reads it aloud.**

## Prompt 02 — prompt file location

`02-get-out-of-the-way-and-hand-off.md` is committed on **`track-e`**, not on `main`, so it
is not in this worktree. It was read from the main clone's checkout. Same situation as
prompt `01` before the merge; noted only so a reviewer diffing `main...HEAD` does not go
looking for it.

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
