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
