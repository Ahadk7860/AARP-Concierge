---
name: ship-mac-app
description: Build, install and VERIFY the Boi Mac app so the running app is provably the code you just changed. Use whenever a Swift change under mac/ needs to reach the user's machine, or when a Mac-side fix "should work" but the app still behaves the old way. Catches stale binaries, silent copy failures, and permission records tied to an old signature.
---

# Ship the Mac app, and prove it shipped

Every step here exists because it silently failed at least once. **A build that reports
success is not evidence the app changed.** Verify by inspecting the installed artifact.

## Why this skill exists

Three separate failures made Mac fixes look ineffective, each invisible from the outside:

1. **The build packaged a stale binary.** `build-app.sh` built universal (`--arch arm64
   --arch x86_64`) then asked `--show-bin-path` *without* those flags, getting a different
   directory. It copied whatever old executable sat there. Every run said "Build
   succeeded" truthfully and shipped the wrong code. The Info.plist is regenerated every
   run, so the bundle looked updated while the executable was a day old.
2. **`cp -R` silently did nothing** because the app was running. macOS will not overwrite a
   running executable. No error, no change.
3. **Permissions were tied to an old signature.** Replacing the bundle (especially
   ad-hoc → Developer ID) leaves TCC records attached to the previous identity, so a
   granted permission reports as denied and macOS never re-prompts.

Boi is `LSUIElement` — **no Dock icon**. Closing the window only hides it. A stale instance
keeps running and relaunching just re-focuses it, which is how an old build survives
"quit and reopen."

## Diagnose, don't guess

This applies well beyond the Mac app. It is here because it was learned the expensive way.

**1. Draw the whole chain before touching anything.** List every place the thing could
break, so the list is mutually exclusive and collectively exhaustive. Names reaching a chat
reply pass through five links:

| # | Link | How to test it |
|---|---|---|
| 1 | Mac can read contacts | `contacts.source record_count` in the log |
| 2 | Mac binds the right source | `contacts.resolution directory_records` |
| 3 | Digest gets names | read `digest.json` on disk and count |
| 4 | Digest uploaded | `upload.dispatch accepted` |
| 5 | Server processed it | `digest.enqueued` then worker log |

Three separate contacts fixes landed correctly and none reached the user, because the break
was at link 4 and then link 5. Every fix "worked". The symptom never moved. **Fixing the
wrong link looks exactly like fixing nothing.**

**2. Test each link with a command, not a theory.** "It should work now" is not a result.
Read the artifact: the installed binary, the file on disk, the server log.

**3. Silence is not evidence.** The ingest worker had `catch {}` and logged nothing on any
path — start, per job, or error. A worker crashing every poll was indistinguishable from a
worker with nothing to do. `build-app.sh` reported "Build succeeded" truthfully while
packaging a day-old binary.

Before concluding "X isn't running" or "X is fine", ask whether X **could** tell you either
way. If it cannot, that is the bug to fix first.

**4. When you cannot see inside, stop theorising and add observability.** Three guesses in a
row about the same failure means the next commit should be a log line, not another fix.
Instrumenting is faster than another wrong hypothesis, and it is permanent.

**5. A contradiction is a gift.** The app said Contacts was "denied" while System Settings
showed *"Applications that have requested access will appear here"* — empty. Both could not
be true. That pointed straight at entitlements, which no amount of staring at the app's own
status code would have revealed. When two sources disagree, that disagreement *is* the lead.

---

## Steps

Run from the repo root: `/Users/skylerluk/Dev/boi-imessage`

### 1. Pick a marker before building

Choose a string that exists **only** in the new code — a new UI label, a new log event.
This is how you prove the binary changed. Record whether it is present now:

```bash
strings /Applications/Boi.app/Contents/MacOS/Boi | grep -c "<marker>"
```

Prefer a user-visible literal. Comments and identifiers may not survive into the binary,
so a count of 0 for those proves nothing.

### 2. Build signed

```bash
BOI_CODESIGN_IDENTITY="Developer ID Application: Skyler Luk (DRP7FWTPFN)" \
  bash mac/scripts/build-app.sh --configuration release
```

Notarization fails with **HTTP 401** unless an app-specific password is configured. That
is the final step, after signing and packaging. **It does not block local install** — ignore it.

### 3. Verify the BUILT binary before installing

```bash
strings /tmp/boi-a/app/Boi.app/Contents/MacOS/Boi | grep -c "<marker>"
```

**If this is 0, stop.** The build did not include your change. Do not install; find out why.

### 4. Force quit — it will not quit on its own

```bash
pkill -9 -f "Boi.app"; sleep 2; pgrep -f "Boi.app" || echo "stopped"
```

### 5. Replace, do not merge

```bash
rm -rf /Applications/Boi.app && cp -R /tmp/boi-a/app/Boi.app /Applications/Boi.app
```

`cp -R` into an existing bundle merges rather than replaces and can leave stale files.

### 6. Verify the INSTALLED app — the step that matters

```bash
ls -la /Applications/Boi.app/Contents/MacOS/Boi | awk '{print $6,$7,$8}'
strings /Applications/Boi.app/Contents/MacOS/Boi | grep -c "<marker>"
codesign -dv /Applications/Boi.app 2>&1 | grep -E "TeamIdentifier|flags"
```

Require: fresh timestamp, marker present, `TeamIdentifier=DRP7FWTPFN`, `flags=...(runtime)`.

### 7. If the change touches a permission

Hardened runtime needs **both halves** for each protected resource, or macOS denies
silently, never prompts, and never lists the app in System Settings:

| Resource | Entitlement | Info.plist key |
|---|---|---|
| Contacts | `com.apple.security.personal-information.addressbook` | `NSContactsUsageDescription` |
| Automation | `com.apple.security.automation.apple-events` | `NSAppleEventsUsageDescription` |

```bash
codesign -d --entitlements - /Applications/Boi.app 2>/dev/null | grep -E "addressbook|apple-events"
plutil -p /Applications/Boi.app/Contents/Info.plist | grep UsageDescription
```

After a signature change, clear stale records so the app can prompt again:

```bash
tccutil reset AddressBook app.boi.mac
tccutil reset AppleEvents app.boi.mac
```

### 8. Relaunch through LaunchServices, not the binary path

```bash
open -a /Applications/Boi.app
```

**This matters for anything permission-related.** Running
`/Applications/Boi.app/Contents/MacOS/Boi` directly from a shell makes macOS attribute
TCC to the *terminal*, not to Boi — Contacts reads 0 records and the test is invalid.

To force a sync with correct attribution:

```bash
nohup open -a /Applications/Boi.app --args --sync --force >/dev/null 2>&1 &
```

Run it **detached**. A foreground wait can hit a tool timeout and kill the sync
mid-run — that has happened, leaving a correct digest on disk that was never uploaded.

### 9. Confirm the run actually finished

A sync takes 60s+ normally, and much longer when contacts resolve. Do not assume.

```bash
tail -5 ~/Library/Application\ Support/Boi/boi.log
```

Look for **`sync.complete`**. `contacts.resolution` alone means it got partway and stopped —
the digest may be on disk and never uploaded, which looks exactly like "the fix didn't work."

## Failure lookup

| Symptom | Cause | Check |
|---|---|---|
| App behaves like the old version | Stale binary, or old instance still running | marker count on the installed binary; `pgrep -f Boi.app` |
| Permission says denied, System Settings lists nothing | Missing entitlement or usage description | `codesign -d --entitlements -`; `plutil -p` |
| Granted, but the app still says denied | TCC record on a previous signature | `tccutil reset` |
| Contacts read 0 records | Launched by path, not `open -a` | relaunch via `open -a` |
| Digest correct on disk but stale in chat | Sync died before upload | look for `sync.complete` |
