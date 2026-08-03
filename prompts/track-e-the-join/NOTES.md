# Track E — notes

Record here: every append to a shared file, every dependency added, every contract
ambiguity found, and every place a prompt's stated assumption turned out to be wrong.

## Shared-file appends

| Prompt | File | What | Why it could not be track-local |
|---|---|---|---|
| 01 | — | none | `BOI_API_BASE` already existed in `.env.example`; see the first row of "Prompt assumptions that were wrong". Two new variables are read but neither is appended — see "Open". |
| review | `scripts/review-capture.sh` | Appended an `e)` case to the track switch, an `e)` line to the interpreter `require` switch, and `e` to the usage string. Nothing reordered or removed. | **The script had no case for `e` and exited 2 on `unknown track: e`.** Track E was added to `gate.sh` and `check-ownership.sh` but not to this one, so Pass 1 could not run at all. The commands mirror `gate.sh`'s `e` case exactly — all four toolchains — rather than inventing a narrower suite. Flagged for the reviewer: **this is the working agent editing the script that captures evidence about its own work**, which is not ideal. The change is a copy of an existing case and is the smallest thing that makes Pass 1 possible; read it first. |
| 02 | `.env.example` | Appended a `# ---- Track E: the join ----` block: `BOI_CORPUS_DB`, `BOI_CORPUS_DIR`, `BOI_PYTHON`, `BOI_INTEL_TIMEOUT_MS`. Append only; nothing reordered or removed. | The bridge cannot run without a corpus path and cannot pick an interpreter safely without one being nameable. The corpus variables carry a comment saying they are the seam that should not exist in production, so nobody reads them as the intended topology. Unlike the prompt-01 token variables these are paths, not secrets, so a named-but-empty value does not read as "configured somewhere else". |

## Contract ambiguities found

The point of this track is to find these. An empty section here after four prompts is
itself a finding — it means the join was tested against fixtures again.

| Prompt | Where | What disagreed |
|---|---|---|
| 01 | `POST /v1/heartbeat` | **Track A's on-disk `Heartbeat` and the frozen wire shape share exactly one field name.** `mac/Sources/BoiKit/Heartbeat.swift` records `{as_of, app_version, bundle_path_stable, full_disk_access, last_successful_sync_at, mirror_message_count, corpus_health}`. `contracts/openapi/boi-api.v1.yaml` requires `{device_id, app_version, digest_as_of}`, permits `{macos_version, fda_granted}`, and sets `additionalProperties: false`; Track D implements it as a strict zod schema. Posting Track A's struct is a `400 validation`. Neither side is wrong against its own tests — Track A never had an HTTP client and Track D never had a Mac. Cost, below. |
| 01 | `digest.user_id` | **The Mac cannot derive `user_id`, and it does.** `DigestBuilder` defaults it to `ContactResolver.localUserIdentifier()` = `usr_ + HMAC(salt, "boi.local.user")[:16]`. The server issues `user_id` at signup with `newUserId()` and returns it from `POST /v1/pair`; `POST /v1/digest` answers `401 unauthorized` when the body's `user_id` is not the authenticated one. So a Mac that has never been told its server-issued id produces a digest that is correct on disk and rejected on the wire, silently, forever. `device_id` does **not** have this problem — `/v1/pair` accepts a client-supplied `device_id`, so the Mac's derived `dev_…` is the one that gets registered. |
| 01 | `POST /v1/pair` | **There is no Mac-side pairing client at all.** The server route exists (Track D) and nothing in `mac/` calls it, references `device_token`, or touches the Keychain — the only mention is a comment in `ContactResolver.swift` saying a salt belongs there. |
| 02 | gist production | **The gist producer cannot run in the cloud, and its output has no route into the cloud either.** Detail below — this is the largest finding in the track so far. |
| 02 | `TickDeps.draftsFor` | **Keyed on `gist_id`, not `contact_id`.** Prompt `02` says `Map<contact_id, DraftBundle>`; `compose.ts:116` does `input.drafts.get(gist.gist_id)`. The composer wins — it is merged, tested code — and the bridge adapts. Harmless because `draft_bundle.v1` carries both, but a bridge built to the prompt's wording would have returned a map the composer silently never hits, producing a brief with no drafts and no error. |
| 02 | `FakeProvider` vs. the real producer | **The determinism control and the real gist producer are mutually exclusive.** `providers/fake.py` replays on `rec["match"]["gist_id_contains"] in suffix`, and the four committed transcripts name four hard-coded ids (`g_11aa22bb`, `g_33cc44dd`, `g_88ee11bb`, `g_99ff00aa`). A gist the producer just made has an id no transcript matches, so `fake` raises `LookupError` and `boi_intel.draft` exits 1. Verified by hand: a real `action_needed` gist (`g_b0421b88ce44`) from the synthetic corpus produces exactly that. So `BOI_MODEL_PROVIDER=fake` can only draft for the committed fixture gists — which is the fixture-based join this track exists to replace. |
| 02 | `composeBrief` | **A digest and a set of gists from different corpora silently produce an empty brief.** `compose.ts:112` drops any gist whose `contact_id` the digest does not carry, and the outcome is `nothing_to_say` — indistinguishable from a genuinely quiet week. Found by seeding `contracts/fixtures/digest/healthy.json` alongside gists from the synthetic corpus. Not a defect in `compose.ts` (inventing a display name would be fabrication), but it is the exact failure a cloud-side gist producer pointed at the wrong corpus would cause, and nothing would report it. |

### The gist producer is on the wrong side of the boundary

Three facts, each verified:

1. **`boi_intel.gist` reads a `chat.db`.** Its only entry point is
   `build_gists(db_path, …)` and `threads.ThreadStats` is built by SQL over `message`,
   `chat_message_join` and `handle`. There is no constructor that takes a digest.
2. **`digest.v1` cannot supply what it needs.** `ThreadStats` requires `last_from_me`,
   `unanswered_question` and `max_gap_days`. `digest.v1.$defs/relationship` has none of
   the three. Without the first two, `gist.classify()` **can never return
   `action_needed`** — the state the entire daily brief exists to deliver, and the one
   worth +0.35 and +0.20 in `priority()`. A digest-driven producer would silently emit
   only `fading` and `dormant`.
3. **There is no route for a gist into the cloud.** `contracts/openapi/boi-api.v1.yaml`
   has `/v1/digest`, `/v1/voice-pack`, `/v1/heartbeat`, `/v1/pair`, `/v1/users/{id}` and
   `/v1/webhooks/{provider}`. `grep -n gist` returns nothing. `CONTRACTS.md` § 1 lists
   `gist.v1` as produced by Track B and consumed by Track D, and nothing carries it
   across.

`BOI_ARCHITECTURE.md` § 6 is unambiguous about where this belongs: T1 gists are
"locally generated" and "uploaded with the daily brief", and § 6.6 puts job **B — gist**
on the **Mac, local model**. Prompt `02` has the producer in the cloud, which would
require the corpus in the cloud, which is the one thing the whole design forbids.

**What was built, and why.** Raised with the user before any code; the ruling was to
have the bridge invoke `boi_intel` over a corpus path it is given, so the join is a real
cross-process invocation producing real `action_needed` gists today, and record the
architectural gap rather than paper over it. `cloud/intelligence-bridge/src/bridge.ts`
opens with the same explanation so nobody reads the code as the intended topology.

**The resolution is a contract amendment and it is the user's:** gist production moves
into the Mac's sync run, and a `POST /v1/gists` ingest route carries `gist.v1` to the
cloud the way `/v1/digest` carries `digest.v1`. Until then `BOI_CORPUS_DB` /
`BOI_CORPUS_DIR` is a seam that should not exist in production.

### A seam that turned out to agree

`contact_id` **matches across Swift and Python on first contact.** Swift's
`ContactResolver.identifier` and Python's `chatdb.contact_id` are two independent
implementations of `h_ + HMAC(user_salt, normalized_handle)[:16]`, written by agents who
never spoke. Run against the same corpus under the same salt, every contact the gist
producer named appears in the Swift digest — `{h_a59a04c4a3a7df90, h_f3bc915f35a84e04,
h_ff450c258dd87371}`, zero gist-only ids. Asserted in
`bridge.test.ts > agrees with the Mac about contact_id`, which builds both sides from
scratch rather than trusting the run above. Worth recording precisely because prompt `02`
predicted a disagreement here and there is not one.

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
| 02 | "the **`TickDeps` construction site only** in `cloud/brief/src/run.ts`" | **There is no construction site.** `TickDeps` is declared in `run.ts` and built only inside `scheduler.test.ts`. Nothing in production has ever assembled one — which is exactly why gap 2 survived four merged tracks and roughly a thousand green tests: *a type with no producer cannot be wrong.* | Added `tickDeps(bridge, rest)` to `run.ts` as the construction site the prompt assumed existed, and corrected the `gistsFor` doc comment, which still said "this track consumes fixtures". `runForUser`'s body is untouched. The bridge is passed in rather than imported, so `cloud/brief`'s own suite still runs with no Python toolchain. |
| 02 | "`gistsFor` … returns gists produced by a real `boi_intel` subprocess, **from a digest** that was inserted through `POST /v1/digest`" | Gists cannot be produced from a digest — see the section below. The digest is read (and, in `pipeline.test.ts`, genuinely inserted through `POST /v1/digest` on a live server) as the gate on whether a Mac has ever reported, but it is not the producer's input. | Built per the user's ruling: the bridge invokes the producer over a corpus path. The DoD line is satisfied as to the digest's provenance and **not** as to the digest being the gist source, and that difference is the finding. |
| 02 | "`draftsFor` returns two candidate drafts per contact … with `BOI_MODEL_PROVIDER=fake`" | Unsatisfiable for gists the producer made — `FakeProvider` only answers for four hard-coded fixture ids. See the `FakeProvider` row above. | The drafting half is driven with a valid `gist.v1` the provider can answer, and the gist half is driven against the real producer. Both cross a real process boundary; neither is stubbed. Real-gist → draft is closed by the live call, which is the one DoD item still open pending a key. |
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

**`pythonExecutable` read the wrong environment, and the test that would have caught it
was the one asserting the least.** The first draft of "cannot pass without Python"
asserted two `not.toBe("unavailable")`s and never ran the bridge with a broken
interpreter — it would have passed with the criterion unmet. Rewriting it properly
exposed a real bug: `invokePython` resolved the interpreter from `options.env` alone,
which carries only the bridge's own `BOI_MODEL_PROVIDER` override, so an operator's
`BOI_PYTHON` was silently ignored while the child was still handed the merged
environment. The two could disagree about which interpreter was in use. Fixed by merging
`process.env` at the resolution site.

**`boi_intel`'s CLIs write their real output to `--out`, and their logs to stdout.**
`draft.py` prints a `draft.produced` event *and* the bundle to stdout; `gist.py` prints a
human summary. A bridge that parsed stdout would work until the day somebody added a log
line. The bridge reads the `--out` file and keeps stdout for diagnostics only. This is
the subprocess trap prompt `02` names, and it is real rather than theoretical.

## Runtime resources

`CONTRACTS.md` § 9 has no row for Track E. Reusing Track D's `3041` and Track A's
`/tmp/boi-a` scratch, both free now that those tracks have merged and stopped.
The Swift suite binds an **ephemeral** loopback port (`NWListener` on `.any`) rather than
a fixed one, and `pipeline.test.ts` listens on port `0`, so nothing in either suite can
collide with anything.

Database: **`boi_dev_e`**, created for this track rather than reusing `boi_dev_d`.
`cloud/db/src/schema.test.ts` drops and rebuilds the schema, and the bridge's two suites
take the same `acquireSuiteLock()` advisory lock that Track D's database tests use — so
within one database nothing runs concurrently with a migration. A separate database also
means prompt `01`'s live evidence run could not disturb Track D's fixtures.

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
- **Prompt `02`'s live-call DoD item is unticked pending a `GEMINI_API_KEY`.** `.env` has
  the variable empty. Everything else in `02` runs on `BOI_MODEL_PROVIDER=fake`; this one
  item — two drafts from the real provider, passing the validator — is the only evidence
  that closes real-gist → draft, since `FakeProvider` structurally cannot. Reported as
  complete-pending-key rather than green.
- **A `POST /v1/gists` route and Mac-side gist production** are the resolution to the
  largest finding in this track. Both are contract amendments and neither is Track E's
  to make.
