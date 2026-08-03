# Track E — notes

Record here: every append to a shared file, every dependency added, every contract
ambiguity found, and every place a prompt's stated assumption turned out to be wrong.

## Shared-file appends

| Prompt | File | What | Why it could not be track-local |
|---|---|---|---|
| 01 | — | none | `BOI_API_BASE` already existed in `.env.example`; see the first row of "Prompt assumptions that were wrong". Two new variables are read but neither is appended — see "Open". |

## Contract ambiguities found

The point of this track is to find these. An empty section here after four prompts is
itself a finding — it means the join was tested against fixtures again.

| Prompt | Where | What disagreed |
|---|---|---|
| 01 | `POST /v1/heartbeat` | **Track A's on-disk `Heartbeat` and the frozen wire shape share exactly one field name.** `mac/Sources/BoiKit/Heartbeat.swift` records `{as_of, app_version, bundle_path_stable, full_disk_access, last_successful_sync_at, mirror_message_count, corpus_health}`. `contracts/openapi/boi-api.v1.yaml` requires `{device_id, app_version, digest_as_of}`, permits `{macos_version, fda_granted}`, and sets `additionalProperties: false`; Track D implements it as a strict zod schema. Posting Track A's struct is a `400 validation`. Neither side is wrong against its own tests — Track A never had an HTTP client and Track D never had a Mac. Cost, below. |
| 01 | `digest.user_id` | **The Mac cannot derive `user_id`, and it does.** `DigestBuilder` defaults it to `ContactResolver.localUserIdentifier()` = `usr_ + HMAC(salt, "boi.local.user")[:16]`. The server issues `user_id` at signup with `newUserId()` and returns it from `POST /v1/pair`; `POST /v1/digest` answers `401 unauthorized` when the body's `user_id` is not the authenticated one. So a Mac that has never been told its server-issued id produces a digest that is correct on disk and rejected on the wire, silently, forever. `device_id` does **not** have this problem — `/v1/pair` accepts a client-supplied `device_id`, so the Mac's derived `dev_…` is the one that gets registered. |
| 01 | `POST /v1/pair` | **There is no Mac-side pairing client at all.** The server route exists (Track D) and nothing in `mac/` calls it, references `device_token`, or touches the Keychain — the only mention is a comment in `ContactResolver.swift` saying a salt belongs there. |

### What the heartbeat disagreement costs

The two fields the contract has nowhere to put are `bundle_path_stable` and
`mirror_message_count` — and `Heartbeat.swift`'s own documentation is explicit that
`bundle_path_stable` is the field the **fleet-wide alarm** is built on:

> If TCC binds a grant to a versioned bundle path, an auto-update drops the grant for
> **every Mac in the fleet on the same day.** […] told apart **only by correlating across
> users**, which requires the server to know which app version each silent Mac was last
> running.

`app_version` does cross, so the correlation is still possible. What is lost is the Mac's
own read of whether its bundle path is versioned — the signal that says *why*.
`CONTRACTS.md` § 10 hole 8 and § 11 item 10 both name this alarm as required.

**This track did not resolve it.** `HeartbeatUpload` maps what fits and drops the rest,
which is the correct action for a track that is wiring rather than fixing, and
`HeartbeatUploadTests` asserts both the mapping and the absence of the two fields so the
gap is visible in the suite rather than only here. The resolution is a contract amendment
adding `bundle_path_stable` and `mirror_message_count` to the `/v1/heartbeat` body, and
that is the user's to make.

## Prompt assumptions that were wrong

| Prompt | Assumption | What is actually true | What was done |
|---|---|---|---|
| 01 | "**New env var:** `BOI_API_URL` […] add it to `CONTRACTS.md` § 5" | `.env.example:19` already ships `BOI_API_BASE=http://localhost:3041` under `# ---- Track A: Mac ----`, with exactly the stated semantics (no path suffix, absolute routes). Adding a second name gives the Mac two config keys for one endpoint. | Raised before writing code; the user ruled: reuse `BOI_API_BASE`, no § 5 append. `Uploader.Configuration.baseURLVariable` is `BOI_API_BASE`. |
| 01 | "bearer `device_token` from the keychain-or-`.env` path Track A already uses" | No such path exists. See the pairing row above. | Raised before writing code; the user ruled: a `TokenStore` protocol with one `.env`/environment implementation (`BOI_USER_ID`, `BOI_DEVICE_TOKEN`). Keychain becomes a second *implementation of the protocol*, not a later rewrite of the call site. Deferred for a testing reason rather than a scheduling one: **Keychain ACLs are per-code-signing-identity, so an unsigned `swift test` binary cannot read what the signed app wrote** — a Keychain-backed test today would need a signed test host, or it would get weakened until it passed. |
| 01 | "the `--dry-run` flag in `BoiCLI/main.swift`" | `--sync` is not in `BoiCLI/main.swift`. It is `Entry.main` → `HeadlessSync.run()` in `mac/Sources/BoiApp/BoiApp.swift`, which **Track E does not own** — `check-ownership.sh e` permits `BoiCLI/main.swift` and not `BoiApp.swift`. `BoiCLI` had no full-run command at all; its existing `sync` command is mirror sync, not `SyncRun`. | Two routes, both shipped: (a) a new `boi-cli sync-run` command in the owned file, which takes `--dry-run` and is what the subprocess tests drive; (b) `Uploader.Configuration.fromEnvironment` reads `--dry-run` from `CommandLine.arguments` as well as the environment, so `Boi.app --sync --dry-run` works without editing a file this track does not own. |
| 01 | "Wiring in `SyncRun.run()` — **the single call site**" | Two edits were needed. The second is `DigestBuilder(options:)` gaining `userID: identity?.user_id`. | Done. It is the *reason* the DoD's `202` is reachable at all — see the `digest.user_id` row. Flagged here because `TRACK.md` limits this file to "narrow, named edits […] each one called out in the prompt that needs it", and this one was not called out. |

## Observations

**`JSONEncoder` is not byte-stable on Darwin.** Twenty encodes of one `CorpusSummary` in
a single process produce **two** distinct strings: Foundation serializes through an
`NSDictionary`, so key order is hash order rather than declaration order. Anything that
hashes an encoder's output, compares two encodings for equality, or assumes a stable
`Content-Length` across encodes is affected. It does not break `voice_pack_version`
(`VoicePackBuilder` canonicalizes deliberately, per `CONTRACTS.md` § 6.3) and it does not
break the upload path (payloads are read back off disk rather than re-encoded), but it
broke the first draft of the test that asserts the queue replays the same bytes, and it
would break any future "did this digest change?" check written the obvious way.

**The uploader reads the artefacts back off disk rather than re-encoding them.**
`DigestBuilder.write` fills explicit nulls (`ExplicitNullJSON`) that a plain
`JSONEncoder().encode(digest)` omits. Re-encoding would upload a document that differs
from the file on disk — and prompt `01` is explicit that the file is the artefact a
support conversation asks for. Asserted byte-for-byte in
`testAFullSyncUploadsTheDigestAndEveryVoicePack`.

**A failed upload makes `--sync` exit non-zero by throwing.** There is no other mechanism
that reaches the shipping entry point: `BoiApp.swift` is not owned by this track, so a
return value cannot change its exit code. `Uploader.Deferred` is thrown from
`SyncRun.run()` **after** the mirror, digest, voice packs, heartbeat and queue are all
durable, so the throw costs nothing but the exit status. Consequence worth naming: a
transient network failure now logs `sync.failed` on the LaunchAgent path. The detail
string distinguishes it (`upload deferred: N queued…`), but a server-side rule alarming
on `sync.failed` would have to read it.

**A stale queued digest can land after a fresher one.** A digest queued on Tuesday
uploads on Wednesday, after Wednesday's own digest has already been accepted. The queue
drains oldest-first *within* a run, but across runs the ordering is by when the server
could be reached, not by `generated_at`. Track D's `latestDigest` should therefore order
on `generated_at` rather than on receipt time. Not verified by this track — worth a look
in prompt `03`.

**Queue ids needed a sequence counter, not a timestamp.** One sync enqueues the digest
and every voice pack with a single `now`, so a millisecond prefix plus a random UUID
suffix ordered them randomly — and the queue drains oldest-first specifically so the
server sees the sequence that happened. Found by a test that read `entries().first`
expecting the digest and got a voice pack.

## Runtime resources

`CONTRACTS.md` § 9 has no row for Track E. Reusing Track D's `3041` / `boi_dev_d` and
Track A's `/tmp/boi-a` scratch, both free now that those tracks have merged and stopped.
The Swift suite binds an **ephemeral** loopback port (`NWListener` on `.any`) rather than
a fixed one, so nothing in it can collide with anything.

## Open

- `SendResult.protocol` is `"imessage" | "rcs" | "sms"`. Spectrum reports
  `"iMessage" | "SMS" | "RCS" | "unknown"`. Decide what `"unknown"` becomes — see `04`.
- `BOI_USER_ID` and `BOI_DEVICE_TOKEN` are read but deliberately **not** added to
  `.env.example`. They stand in for a pairing exchange that has no Mac-side client, and a
  named-but-empty variable in the example file would read as "this is configured
  somewhere" rather than "this is missing". Once a pairing client exists both should come
  from the Keychain and neither variable should survive.
- Prompt `01`'s first DoD line — "the row is visible in the database" — needs a live
  `cloud/api` against Postgres and a paired user, which is a runtime step rather than a
  code one. Reported in the pass-1 evidence, not asserted by the Swift suite.
