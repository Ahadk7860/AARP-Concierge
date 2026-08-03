# Track E — Prompt 01: the Mac has never sent a byte

**Depends on:** nothing. Start here.

## Context

Read `TRACK.md` and `prompts/CONTRACTS.md` first.

`grep -rl "URLSession" mac/Sources/` returns nothing. Track A built a sensor that reads
`chat.db`, maintains a mirror, decodes typedstream, guards `is_from_me` three times and
writes `out/digest.json` — and then stops. The digest has never left the Mac.

This prompt is the smallest of the four and the one most likely to be got wrong quietly,
because the failure mode of an uploader is **a log line that says success**.

## Objective

`boi --sync` reads, builds, and uploads. A digest that fails to upload is retried later
rather than lost, and no message content appears anywhere in the process.

## Scope

**In scope:**

- `Uploader.swift`: `POST /v1/digest`, `POST /v1/voice-pack`, `POST /v1/heartbeat` against
  `BOI_API_URL`, bearer `device_token` from the keychain-or-`.env` path Track A already uses.
- `UploadQueue.swift`: a durable on-disk queue under `stateDirectory`. A digest that could
  not be uploaded is enqueued and retried on the next sync.
- Wiring in `SyncRun.run()` — after the digest is written, not instead of writing it. The
  file on disk stays; it is the only thing a support conversation can ask for.
- Exponential backoff with jitter, capped. A Mac that wakes to no network must not hammer.
- `--sync --dry-run` prints what *would* be uploaded, with the body redacted, and uploads nothing.

**Explicitly out of scope:**

- Pairing. Assume a `device_token` exists; `04` in Track D issues it.
- Any change to what the digest *contains*. Track A owns that and it is merged.
- TLS pinning, retries across app restarts beyond what the on-disk queue gives you.

## Constraints

- **Paths you may modify:** `mac/Sources/BoiKit/Uploader.swift`, `mac/Sources/BoiKit/UploadQueue.swift`,
  `mac/Tests/BoiKitTests/UploaderTests.swift`, plus **the single call site** in
  `SyncRun.run()` and the `--dry-run` flag in `BoiCLI/main.swift`.
- **Paths you must not touch:** everything else in `mac/`, and all of `cloud/` and `intelligence/`.
- **Contracts:** `POST /v1/digest`, `/v1/voice-pack`, `/v1/heartbeat` in
  `contracts/openapi/boi-api.v1.yaml` — frozen. `digest.v1` and `voice_pack.v1` — frozen.
- **New env var:** `BOI_API_URL`. It **includes no path suffix** — the routes are absolute.
  Record it in `NOTES.md` and add it to `CONTRACTS.md` § 5.

## The constraint that is not negotiable

`CONTRACTS.md` § 7 says no message content in any log, test, commit or report. An uploader
is the single most likely place to violate that by accident, because the natural thing to
log on a failure is the request body — and the request body is the digest.

**Log the byte count, the schema version, the `as_of`, and the HTTP status. Never the body.**
On a 400, log the server's error code, not the payload that produced it. This is the one
place in the whole system where a debugging convenience is a data breach.

## Definition of Done

- [ ] `boi --sync` against a local API server produces a `202` on `/v1/digest` and the row is visible in the database
- [ ] The voice pack uploads too, and `scripts/check_voice_pack_leak.py --mirror` still exits zero on the uploaded artifact
- [ ] **A 500 from the server enqueues the digest and returns non-zero from `--sync`.** A silent success on a failed upload is the defect this criterion exists to catch — assert on the queue's contents, not on the log
- [ ] The queued digest uploads on the next successful sync, and is removed from the queue only after a `2xx`
- [ ] The queue survives process death: kill the process between enqueue and upload, restart, and the digest is still there
- [ ] Backoff is bounded and jittered — assert that 10 consecutive failures produce no more than N attempts within a window, with a controlled clock rather than `sleep`
- [ ] `--sync --dry-run` uploads nothing, and its output contains the byte count but **no substring of any message body**
- [ ] **No message content in logs:** run a full sync against the synthetic corpus with logging at its most verbose, and grep the log for 20 known message substrings from the fixture. Zero hits. Commit the grep as a test.
- [ ] `swift test --package-path mac` exits zero, including every pre-existing Track A test
- [ ] Ownership holds: `bash scripts/check-ownership.sh e` exits zero on `git diff --name-only main...HEAD`

## What to report

The three-pass review in `prompts/TRACK-REVIEW.md`. For pass 1, the evidence that matters
most is the last two criteria: the failed-upload path and the log grep. Paste the actual
command and the actual zero-hit output, not a summary of it.
