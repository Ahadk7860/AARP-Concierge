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
