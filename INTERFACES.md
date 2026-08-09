# Cross-Session Interface Log

Two build sessions are working this repo in parallel:

- **Claude Code** (Opus 5 orchestrator + Sonnet 5 executors) — Tracks A, B, C, D, H
- **DeepSeek v4 Pro** (Cline/VSCode, sequential) — Tracks E, F, G

Frozen interfaces live in `V3_ARCHITECTURE.md` §4. **Do not change them silently.**

## How to use this file

Append an entry when you:

1. Edit a **shared file** — `cloud/api/src/main.ts`, `cloud/shared/src/contracts.ts`,
   `mac/Sources/BoiKit/SyncRun.swift`
2. Find a problem with a frozen interface (implement it as specified anyway, then log it)
3. Need something from the other session's files

Newest entries at the bottom. Keep them to two lines.

```
### <date> · <session> · <track>
<what changed / what is needed / what is wrong>
```

---

## Cross-session artifacts

Two files are created by one session and imported by the other. **The creator owns them; the
importer never edits them.** Log here the moment each lands.

| File | Created by | Imported by | Spec |
|---|---|---|---|
| `cloud/shared/src/intents.ts` | DeepSeek (G0) | Claude (Track B router) | §4.2a |
| `cloud/channel/src/progressive.ts` | DeepSeek (F2) | Claude (Track B agent) | §4.4 |

Claude develops against stubs for both until they land — the signatures are frozen, so
integration is an import swap.

---

### 2026-08-08 · setup · —
Interfaces frozen in `V3_ARCHITECTURE.md` §4. Both sessions start here.

### 2026-08-09 · Claude · Track D
Smallest-possible edit to shared `mac/Sources/BoiKit/SyncRun.swift`: `Paths.installed()` now resolves
`chatDatabase` via `MessagesFolderAccess.resolvedChatDatabasePath` (falls back to the untouched FDA
default on any failure, so an FDA-only user is unaffected), and the heartbeat wire call site now passes
`messagesAccessState`. New optional field `HeartbeatUpload.messages_access_state` (Uploader.swift) —
`"ok" | "never_configured" | "lost"` — is **not yet in the frozen contract**
(`contracts/openapi/boi-api.v1.yaml` sets `additionalProperties: false` on the heartbeat shape, so the
server currently drops this key on validation). Flagging for Track F or H: amend the OpenAPI contract +
TS zod schema to accept it, then wire `cloud/channel/**` to text the user when a device reports `"lost"` —
that is the headless-3am-failure case a local macOS notification (`RecoveryNotifier.swift`, `BoiApp`)
alone cannot reach, because nobody is looking at the Mac when it happens.

### 2026-08-09 (later) · Claude · Track D
Correction to the entry above: `messages_access_state` is **not currently sent on the live heartbeat
upload at all** (reverted in a follow-up commit after `swift test` proved a real device would get every
heartbeat `400`-rejected the moment the field carried a non-nil value — `additionalProperties: false`
rejects the whole body, not just the unknown key). The field still exists on `HeartbeatUpload` and
`MessagesFolderAccess.classifyRecoveryState` still drives the local notification; only the network call
is unwired. Re-wire the `SyncRun.swift` call site once the contract permits the field — do not assume
it is already flowing to the server from this track's work.

### 2026-08-09 (later still) · Claude+orchestrator · Track D — for the DeepSeek session too
**`swift test` on this repo was silently POSTing to the real production API before commit `649ce42`.**
`mac/Tests/BoiKitTests/AppBundleTests.swift` constructed `SyncRun` at six call sites with no uploader
injected; the default resolves `Uploader.Configuration.fromEnvironment()` against the real
`~/Library/Application Support/Boi/.env`, which on ANY machine that has ever paired a real device holds
real production credentials. This was true on every `swift test` run on this specific machine prior to
the fix, including at least two runs the orchestrator (Claude, this session) ran directly in this
worktree, and an unknown number of Track D's own runs earlier in this track. If DeepSeek's session
shares this machine or a machine with a similarly-paired `.env`, the same was true there — there was
nothing repo-specific that would have stopped it; the six call sites are in a file DeepSeek's tracks
do not own but `swift test` runs the whole suite regardless of which track invokes it.
Fixed two ways in `649ce42`: (1) the six call sites now inject a `dryRun` uploader; (2)
`Uploader.Configuration.applicationSupportDirectoryDefaultForCurrentProcess` now refuses the real
Application Support directory whenever `Uploader.Configuration.isRunningUnderXCTest` is true (detected
via `NSClassFromString("XCTestCase") != nil`, not the commonly-cited `XCTestConfigurationFilePath`
environment variable, which measurement showed is NOT set by SwiftPM's `swift test` — only by Xcode's
own test host). A test that forgets to inject an uploader now gets `upload.not_configured` instead of a
real network request, regardless of which track wrote it or which session runs it.
