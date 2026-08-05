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
- A production `pmset schedule wake` permission failure remains visible as
  `wake.command_failed` plus `wake.lifecycle_degraded`; it does not overwrite a
  successful sync result or prevent foreground onboarding from reaching its handoff.
