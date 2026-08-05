# Track G — Mac shipping notes

## Prompt 01 — scheduled wake planner and measurement seam

### Evidence

- `swift test --filter WakeScheduler`: 14 tests passed, 0 failed.
- `swift test`: 279 tests executed; 278 passed. The one failure is the existing
  `DigestAmendment001Tests.testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus`.
  This worktree has no `.venv`, so that test falls back to Xcode's Python 3.9 and fails
  importing `datetime.UTC`; the project declares Python 3.11 or newer. All scheduled
  wake tests present in the full run passed.
- No physical `pmset` command was executed. Scheduler tests used only the injected fake
  command runner. The local `pmset(1)` manual was read to confirm the documented
  `MM/dd/yy HH:mm:ss` input format.

### Measurement status

- Battery cost and Messages iCloud pull evidence are **not measured yet**. The pending
  result harness creates four evidence-empty observations and reports neither gate as
  passed.
- `pmset(1)` documents that modifying power settings requires root. Prompt 01 adds no
  `sudo`, privileged helper, persistent sleep setting, or other escalation path; a
  permission failure is returned and emitted as an error log. The eventual authorized
  installation/wiring path remains unresolved and is intentionally outside this prompt.

### Deliberately not wired

- `WakeScheduler` is not called from `SyncRun`, the LaunchAgent, or `BoiApp` in prompt 01.
- No release, signing, notarization, or frozen contract/schema file was changed.

## Prompt 02 — app lifecycle wiring

### Evidence

- `swift test --filter 'WakeScheduler|LaunchAgentTests'`: 29 tests passed, 0 failed.
- `bash mac/scripts/build-app.sh --out /tmp/boi-a/app`: built and ad-hoc signed the
  local test bundle. Its parsed LaunchAgent plist contains only `--sync` and the four
  `StartCalendarInterval` entries at 08:00, 12:00, 17:00, and 21:00; it contains no
  `StartInterval` fallback.
- `swift test`: 289 tests executed; 288 passed. The sole failure is the same unrelated
  worktree environment issue recorded above: no `.venv` means the test falls back to
  Xcode Python 3.9, which cannot import `datetime.UTC`. Every wake lifecycle and
  LaunchAgent test passed in the full run.
- No app executable was launched and no physical `pmset` command was run. Lifecycle
  tests inject the scheduler; the bundle build only compiles and embeds the plist.

### Remaining physical gate

- Battery drain and real phone-originated Messages iCloud-pull evidence remain
  unmeasured. Prompt 02 wires the production boundary but does not claim either result.
- Superseded by the review fix below: production now fails before invoking `pmset`, with
  explicit authorization-unavailable degradation. It does not overwrite a successful
  sync result or prevent foreground onboarding from reaching its handoff.

## Independent review fixes — wake honesty and measurement proof

### Ordinary app behavior

- The ordinary Boi app no longer executes `/usr/bin/pmset`. Its scheduler fails closed
  with `authorizedHelperUnavailable`, which becomes a visible
  `wake.lifecycle_degraded` result. LaunchAgent status and RTC-wake authorization are
  shown as separate states, so an enabled agent no longer implies closed-lid freshness.
- Foreground scans, reports, and handoff remain usable when RTC scheduling is degraded.
  No `sudo`, AppleScript password prompt, privileged install, or physical power command
  was added or invoked.

### Exact minimal privileged amendment still needed

The next implementation needs an explicitly user-approved, signed, least-privilege wake
helper. The minimal package/ownership amendment is:

1. Permit `mac/Package.swift` and `mac/Sources/BoiWakeHelper/**` to add a
   `BoiWakeHelper` executable target. Permit the app build/release scripts to place that
   signed executable at `Boi.app/Contents/Resources/BoiWakeHelper`.
2. Permit a dedicated launchd plist at
   `Boi.app/Contents/Library/LaunchDaemons/app.boi.mac.wake-helper.plist`, using
   `BundleProgram` to name the bundled Resources executable and exposing one authenticated
   Mach/XPC service. Register it with macOS 13+ `SMAppService.daemon(plistName:)`; an admin
   must explicitly approve it before launchd bootstraps the daemon.
3. Freeze helper IPC to one argument-free request: **reschedule the next Boi wake**. The
   helper computes the next local 08:00/12:00/17:00/21:00 time itself, lists events for
   idempotency, and executes only `/usr/bin/pmset schedule wake <computed-date>`. No date,
   argv, shell, cancel-all, repeat, sleep, or disable-sleep input crosses IPC.
4. Add a BoiApp XPC client that supplies `WakeSchedulerLifecycle.Schedule` through the
   existing lifecycle injection seam and maps the helper's typed response to scheduled /
   already-scheduled / degraded. Until that approved client exists, the ordinary app
   initializer remains authorization-unavailable.

This requires a real signed/notarized nested-code build and explicit user approval; an
ad-hoc test bundle cannot prove the authorization boundary.

### Strengthened physical evidence gate

- Measurement schema v2 requires four unique local planned slots (08:00, 12:00, 17:00,
  21:00), four observed wakes no more than 15 minutes late, bounded wake windows, and
  per-wake artifacts before reporting a closed-machine battery result.
- Messages iCloud pull additionally requires four unique opaque phone-message evidence
  ids, phone-origin artifacts, proof each message was absent from `chat.db` after it was
  sent but before the wake, and proof it appeared between the observed wake and window
  end. Arbitrary times, duplicate slots/evidence, missing wakes, and missing before/after
  artifacts all fail the gate.
- These are data-shape and mutation tests only. Battery drain and a real phone-originated
  arrival remain unmeasured until the authorized helper exists and a physical run occurs.

### Review-fix verification

- `swift test --filter 'WakeScheduler|LaunchAgentTests'`: 37 tests passed, 0 failed.
- `swift test`: 297 tests executed; 296 passed. The sole failure remains the unrelated
  `DigestAmendment001Tests.testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus`
  fixture bootstrap: this worktree has no project `.venv`, so Xcode Python 3.9 cannot
  import `datetime.UTC`.
- No privileged helper was installed or invoked, no physical `pmset` command ran, and no
  physical closed-lid/iPhone measurement is claimed by this verification.

## Prompt 03 — least-privilege wake helper

### Implemented boundary

- SwiftPM now builds `BoiWakeHelper` as a separate executable. `build-app.sh` embeds it
  at `Boi.app/Contents/Resources/BoiWakeHelper`, embeds the dedicated daemon plist at
  `Contents/Library/LaunchDaemons/app.boi.mac.wake-helper.plist`, signs the nested helper
  first, and signs the outer app last.
- The plist uses `BundleProgram=Contents/Resources/BoiWakeHelper` and exposes exactly one
  Mach service, `app.boi.mac.wake-helper`. The app registers and reports it through
  `SMAppService.daemon(plistName:)`; the existing LaunchAgent still invokes the main app
  for Full-Disk-Access-protected sync work.
- XPC exposes exactly one argument-free method, `reschedule(reply:)`. The caller cannot
  supply a date, executable, argv, command, or power mode. The root helper uses its own
  clock and `WakeScheduler` to select the next local 08:00/12:00/17:00/21:00 slot.
- The privileged process command policy accepts only `/usr/bin/pmset -g sched` and
  `/usr/bin/pmset schedule wake <internally formatted date>`. Mutations to shell,
  repeat, sleep, wake-or-power-on, cancel-all, invalid dates, and extra arguments fail.
- Superseded by the independent-review fix below: production derives the Team ID from
  validated self-signatures and installs exact same-team peer requirements directly on
  the listener and connection before activation. No PID lookup remains. Missing Team ID
  (including ad-hoc signing), wrong identifier/team/anchor, or unverifiable code fails
  closed; tests inject only the self-identity and validation seams.
- Both initial registration and subsequent headless sync scheduling use the typed helper
  response through the existing `WakeSchedulerLifecycle.Schedule` seam. Missing,
  rejected, interrupted, unapproved, or timed-out helper access stays visible as degraded
  closed-lid freshness and does not make foreground reports unusable.

### What the local dry run proves — and does not prove

- `bash mac/scripts/build-app.sh --out /tmp/boi-a/app` builds the two products, embeds the
  plist/helper at the required paths, signs nested code before the outer app, lints both
  service plists, and passes strict code-sign verification.
- This dry run is ad-hoc. Its `codesign -dv` output says `TeamIdentifier=not set`, so the
  production helper authorization deliberately rejects it. It proves bundle shape and
  seal integrity only; it does not prove daemon approval, XPC authorization, or RTC wake.
- This prompt did not call `SMAppService.register()`, install/bootstrap the daemon, launch
  `BoiWakeHelper`, or execute physical `pmset`.

### Exact gates before physical validation

1. **Developer gate:** build the helper and outer app with the same valid Developer ID
   Application certificate (`BOI_CODESIGN_IDENTITY`), hardened runtime, and timestamp;
   verify identifiers `app.boi.mac.wake-helper` and `app.boi.mac`, matching nonempty Team
   IDs, nested strict verification, notarization, and stapling. An ad-hoc or differently
   signed build cannot pass caller authorization.
2. **Install/user gate:** place that stable notarized bundle in `/Applications/Boi.app`,
   launch it normally, and have the user choose **Enable background refresh**. Separately,
   the user must grant Full Disk Access to the main Boi app for Messages reads; the root
   helper neither receives nor needs that TCC grant.
3. **Admin/macOS gate:** an administrator must approve the embedded LaunchDaemon in
   System Settings > General > Login Items when macOS requests it. Do not claim wake
   scheduling until `SMAppService.daemon(...).status == .enabled`; `requiresApproval`,
   `notRegistered`, and `notFound` remain degraded states.
4. **Physical evidence gate:** only after all three gates pass may a signed installed app
   issue the argument-free XPC request, inspect the resulting scheduled event, close the
   on-battery Mac, and collect the four-wake battery/iPhone artifacts required by
   measurement schema v2. No such physical result exists yet.

### Prompt 03 verification

- Focused `WakeScheduler|LaunchAgentTests|AppBundleWakeHelperTests`: 48 passed, 0 failed.
- Full Swift suite: 310 tests discovered and executed; 309 passed. The sole failure is
  still the unrelated
  `DigestAmendment001Tests.testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus`
  bootstrap, because this worktree has no project `.venv` and Xcode Python 3.9 cannot
  import `datetime.UTC`.
- Bundle dry run, source and embedded LaunchDaemon `plutil -lint`, nested-helper strict
  verification, outer-app deep strict verification, `git diff --check`, and Track G
  ownership all passed. No daemon registration or physical power operation was run.

## Independent helper review fixes

- The sync LaunchAgent now uses `BundleProgram=Contents/MacOS/Boi` and the fixed argv
  `Boi --sync`. Its generator ignores the legacy absolute `--binary` value, rejects
  `Program`, absolute `.app` paths, changed bundle programs, and changed argv. Builds in
  `/tmp/boi-g-relocation-a` and `/tmp/boi-g-relocation-b` produced byte-identical agent
  plists containing neither staging path; the shipped build no longer adds `/tmp` log
  paths either.
- PID-based guest lookup was removed. The helper validates its own exact helper
  identifier, Developer ID anchor, and nonempty Team ID, then calls macOS 13
  `NSXPCListener.setConnectionCodeSigningRequirement` with the exact same-team app
  requirement before listener activation. The app performs the symmetric self check and
  calls `NSXPCConnection.setCodeSigningRequirement` for the exact helper before activating
  its connection. Ad-hoc, wrong-id, wrong-team, invalid-anchor, and unverifiable code all
  fail closed; injected identity/validation seams exercise these paths without weakening
  production.
- Background setup is daemon-first. It registers/rechecks the daemon, publishes
  `requiresApproval`, exposes **Open System Settings** using
  `SMAppService.openSystemSettingsLoginItems()`, and keeps observing without another
  click. Only an enabled daemon permits agent registration; only a re-read enabled agent
  permits the asynchronous initial wake request. No intermediate state says registered.
- The helper command policy now parses the proposed local date and requires it to equal
  `WakeScheduler.nextWake` from the transaction's captured clock/calendar. A syntactically
  valid `09:13:47`, a later valid product slot, sleep/repeat/cancel variants, extra argv,
  and shell executables all fail mutation tests.
- One shared serial transaction queue encloses the complete scheduler call, including
  `pmset -g sched` and its conditional `schedule wake`, across every XPC connection.
  Concurrent tests record a maximum of one active transaction.
- The app client is async and cancellation-aware, owns the XPC connection until a terminal
  result, invalidates it on success/failure/cancellation/timeout, and ignores late replies.
  GUI setup runs in a Task rather than blocking for ten seconds. The helper's `pmset`
  process has a five-second deadline, TERM grace period, and bounded KILL fallback.
- Review verification did not call either `SMAppService.register()`, launch the helper,
  execute `pmset`, or exercise live System Settings approval. Ad-hoc bundles remain layout
  evidence only because their Team ID is absent and the production requirement rejects
  them.

### Independent-review verification

- Focused `WakeScheduler|LaunchAgentTests|AppBundleWakeHelperTests`: 53 passed, 0 failed.
- Full Swift suite: 315 executed, 314 passed. The sole failure remains the unrelated
  `DigestAmendment001Tests.testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus`
  fixture bootstrap: this worktree lacks the project `.venv`, and Xcode Python 3.9 cannot
  import `datetime.UTC`.
- Two-path relocation build and byte comparison, source and embedded `plutil -lint`,
  nested-helper strict signing verification, outer deep strict signing verification,
  `git diff --check`, and Track G ownership passed. No service registration, helper
  execution, live approval, or physical power command occurred.
