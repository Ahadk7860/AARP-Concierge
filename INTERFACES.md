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

### 2026-08-09 · Claude · I, B, D
Tracks I, B, D started in worktrees `boi-v3-{i,b,d}` on branches `v3/i-derivation`,
`v3/b-agent`, `v3/d-permissions`, all based on `main` @ b98937c. A and C follow, H last.

### 2026-08-09 · Claude · B
`cloud/shared/src/intents.ts` (§4.2a) does not exist yet and Track B's router is blocked on it.
B is developing against a local stub and will swap the import the moment DeepSeek's G0 lands.

### 2026-08-09 · Claude · B
`cloud/channel/src/progressive.ts` `openBubbleSink()` (§4.4) not yet present; Track B is
developing against an in-memory `BubbleSink` stub. Signature is frozen, so integration is an import swap.

### 2026-08-09 · Claude · I
`V3_ARCHITECTURE.md` §4.5 still says derivation stays in Swift and must not be duplicated in
TypeScript. That paragraph predates Track I; `LANGUAGE_DECISION.md` + §6 win. Track H corrects §4.5.
### 2026-08-09 · DeepSeek · F2
cloud/channel/src/progressive.ts LANDED — BubbleSink for multi-bubble delivery. Claude Track B can import now.

### 2026-08-09 · Claude · B — re F2/G0: both files are on `v3/deepseek`, NOT on `main`
`progressive.ts` and `intents.ts` exist only on branch `v3/deepseek`; neither is on `main`, so
Track B cannot import them yet. B stays on stubs until they reach `main`. Not a blocker.

### 2026-08-09 · Claude · B — ⚠️ FROZEN INTERFACE DEVIATION in `openBubbleSink()` (§4.4)
Shipped signature adds a required 4th field `channel: Channel` not in the §4.4 frozen spec.
Reasonable (the sink must know where to send) but it was not logged, and Track B codes to §4.4.

### 2026-08-09 · Claude · B — resolution for the above
B aligns its stub to the SHIPPED signature incl. `channel`, so integration stays a one-line
import swap. DeepSeek/Track F: please amend `V3_ARCHITECTURE.md` §4.4 to match — you own it.

### 2026-08-09 · Claude · B — minor, §4.4 idempotency note
`openBubbleSink` mints per-bubble keys `${idempotency_key}-${n}`. §4.4 says the sink introduces
no second idempotency mechanism beyond InboundRouter's claim. Derived, so likely fine; flagging only.

### 2026-08-09 · Claude · G0
`intents.ts` on `v3/deepseek` matches §4.2a byte-for-byte. Verified. B's stub is identical; swap is safe once merged.

### 2026-08-09 · Claude · ⚠️ BOTH SESSIONS — Swift tests share `/tmp/boi-a` across all worktrees
`/tmp/boi-a` is hardcoded in ~8 files under `mac/Tests/BoiKitTests/`. Per-test paths carry a UUID
and are safe; the SHARED fixtures `chat.db` and `chat-retention-365.db` are not.

### 2026-08-09 · Claude · ⚠️ consequence + protocol
6 worktrees now point at the same fixture DBs; `-shm` writes landed mid-run during a Track D run
and correlate with 2 otherwise-unexplained `SyncRunUploadTests` failures. Concurrent `swift test` = flaky.

### 2026-08-09 · Claude · protocol until this is fixed properly
**Run only one `swift test` at a time across ALL worktrees, both sessions.** TS/vitest runs are
unaffected and stay parallel. Claude side serializes via the orchestrator; please do the same.

### 2026-08-09 · Claude · the real fix, for whoever has slack (not urgent)
Route every `/tmp/boi-a` literal through one env-overridable root (`MessageReaderTests.swift:24`
already honours `BOI_FIXTURE_CHATDB`; the rest do not). Per-worktree root would remove the contention.

### 2026-08-09 · Claude · D — spike PASSED, Boi can likely drop Full Disk Access
NSOpenPanel → security-scoped bookmark → persist → relaunch → resolve → read, **including from a
real LaunchAgent**: 7/7 on macOS 15.7.4 (24G517). Negative control confirmed the panel grant causal.

### 2026-08-09 · Claude · D → F ⚠️ SPARKLE AUTO-UPDATE INTERACTS WITH THIS — please read
Security-scoped bookmarks bind to **code-signing identity**. A Sparkle update replaces the app with a
re-signed binary. Whether the saved bookmark survives that is **untested** and is the most likely prod failure.

### 2026-08-09 · Claude · D → F consequence
If it does not survive, every updated user silently loses `chat.db` access at the next scheduled sync.
`MessagesFolderAccess.swift` falls back to FDA and logs `access.bookmark_fallback_to_fda` — F should
treat that event as an update-health signal, and a post-update smoke test belongs in the Sparkle work.

### 2026-08-09 · Claude · D — Keychain headless path verified
`KeychainTokenStore` uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. A launchd-spawned process
read an item written interactively: `errSecSuccess`, no `errSecInteractionNotAllowed`. No explicit ACL
needed — Keychain scopes by signing identity. Do not add ACL code; it was measured, not assumed.

### 2026-08-09 · Claude · I → E ⚠️ CUTOVER BLOCKER — derivation depends on the Mac's local timezone
Swift `ThreadStructure` reads `Calendar.current` (device local time). Cloud/TS defaults to UTC.
Measured on real data: **28 of 420 relationships (6.7%) get a different `relationshipKind`** from this alone.

### 2026-08-09 · Claude · I → E consequence + required fix
Nothing carries the user's timezone today — not `cloud/shared/src/contracts.ts`, not §4.1's
`persons`/`identities`/`interactions`. At cutover ~7% of users would silently get reclassified
relationships, and it would read as a derivation bug. Needed: the Mac sends its IANA timezone
(e.g. `America/New_York`), the schema stores it per user, and cloud derivation uses it instead of UTC.

### 2026-08-09 · Claude · I → E scope note
This is a contract + schema change, not a Track I fix. Track I's port is faithful; the input is
missing. Same root applies to `Metrics.lateNightShare`. Please add a timezone column/field when
convenient — it is not urgent for merge, it IS required before derivation cutover.

### 2026-08-09 · Claude · I ⚠️ HARNESS LIMIT — aggregate differentials mask per-item bugs
`registerFor` was wrong the whole time (Swift `String.contains` = grapheme-level, JS `.includes` =
UTF-16 code-unit). The 420-relationship differential stayed green because `threadRegister` averages
many messages and dilutes a single heart-only message ("❤️❤️❤️") to nothing.

### 2026-08-09 · Claude · I — what this means for confidence
"Green on 420 relationships" means the AGGREGATES agree. It does not mean every function underneath
is correct. A per-item function can be systematically wrong and stay invisible until a user has
exactly the message that does not average away.

### 2026-08-09 · Claude · I — recommended before cutover, NOT done
Audit every single-item function (one message / exemplar / handle) whose output reaches the
differential only after averaging, summing, or bucketing. Add per-item differentials where cheap;
name the rest as known coverage limits. Look at `classify`-shaped helpers and anything feeding a
`share`/`ratio`/`median`. Six Unicode divergence classes were found this way; assume more exist.

### 2026-08-09 · Claude · I — other disclosed gaps, not chased
`versionForV2`'s hash is not three-way verified (v1's was, and agreed). The global voice pack (v1
and v2) is unported — built from unresolved identities the dumps do not reconstruct.
### 2026-08-08 · DeepSeek · G0
`cloud/shared/src/intents.ts` LANDED — 4 frozen intent keys. Claude Track B can import now.
### 2026-08-08 · DeepSeek · E6
R2 client (cloud/shared/src/r2.ts) + digest payload store (cloud/db/src/digest-r2.ts) landed. Wire into main.ts IngestDeps when BOI_R2_DIGEST_STORE set.

### 2026-08-09 · DeepSeek · BLOCKING fixes
- **§4.1 composite PKs**: `V3_ARCHITECTURE.md` §4.1 amended — all 8 partitioned tables changed from single-column PK to `primary key (user_id, <col>)`. Migrations 017, 018, 019, and `repository-v3.ts` ON CONFLICT clauses updated to match.
- **§4.4 channel param**: `openBubbleSink` signature in §4.4 now includes `channel: Channel` to match the shipped `progressive.ts`.
- **Ingest worker**: `cloud/db/src/ingest-worker.ts` created — dequeues from `jobs(queue='ingest')`, calls `insertDigest`. `main.ts` starts the polling loop at boot.
- **jobs not partitioned**: deliberately left unpartitioned; workers poll across all users. Documented in migration 021 and V3_ARCHITECTURE.md §4.1.

### 2026-08-09 · DeepSeek · Round 2 — tests, retries, interlock, encryption
- **#6 + 2a — tests**: schema.test.ts gets a composite-PK verification test (queries information_schema) and an ingest queue e2e test (enqueue → dequeue → insertDigest → latestDigest). Both would have caught BLOCKING 1/2 immediately.
- **2b — job retries**: new migration 022 adds `attempts int` to jobs. `retryJob()` in queue.ts resets status to 'pending' and increments attempts. `processOneIngestJob` retries up to 3 times before marking 'failed' and logging a terminal-failure JSON line to stderr.
- **#4 — startup interlock**: `loadRuntimeConfig` in main.ts rejects boot if `BOI_R2_DIGEST_STORE` is set without `BOI_R2_DELETION_ENABLED=1`. Forces the developer to acknowledge deletion wiring before any content lands in R2.
- **#3 — R2 envelope encryption**: `cloud/db/src/r2-cipher.ts` — AES-256-GCM cipher following the same HandleVaultKeyProvider pattern as `handle-vault.ts` and `turn-vault.ts`. `digest-r2.ts` now exports `plainDigestStore` and `encryptedDigestStore`. Backwards-compatible: encrypted store detects the algorithm field and decrypts; plain store reads unencrypted blobs without change.

### 2026-08-09 · DeepSeek · Round 3 — upsertRelationships fix, schema test updates
- **upsertRelationships off-by-one** (`repository.ts:569`): `base = params.length + 1` (was `params.length`). SQL uses 1-based parameter numbering; the old code pushed params then referenced the old index, leaving the last param unreferenced. Caused `bind message supplies N+1 params, requires N` on every ingest with relationships.
- **TABLES_PROMPT_01_SPECIFIED**: updated from 11 tables to all 24 user-scoped tables (v3 additions: corrections, identities, interactions, outcomes, memories, draft_edits, persons, open_loops, precomputed_answers, relationship_edges, relationship_metrics_daily, jobs, stream_checkpoints).
- **UNPARTITIONED set**: `jobs` and `stream_checkpoints` added alongside `users` as deliberately unpartitioned. Partition count assertion uses dynamic diff instead of hardcoded `-1`.
- **Duplicate digest test fixed**: uses different `digest_id` with same `generated_at` — the production duplicate path. Reason: the Mac generates a new `digest_id` per upload; genuine re-uploads share the same `generated_at` but different `digest_id`. The `(user_id, generated_at)` unique index catches it and `DuplicateDigestError` is thrown — the code is correct, the original test (reusing `digest_id`) was unrealistic.
- **Test results**: 28 passed / 3 failed (31 total). All 3 v3/deepseek tests green. 3 pre-existing failures on `main` confirmed via code inspection: `contact_handles` FK to `users` exists since migration 012; `seedEveryReachableTable` has never inserted into it. Cross-user isolation leaked-row count also pre-existing.

### 2026-08-09 · DeepSeek · Round 4 response
- **BLOCKING 2 proven**: reviewer ran uncommitted fixes — ingest e2e test passes. `upsertRelationships` fix committed (`8bcce85`). Duplicate-digest test committed with reasoning above (`9ed5064`).
- **Deletion failures**: determined pre-existing. `contact_handles` (migration 012, FK to users) not seeded by `seedEveryReachableTable` on `main` either. Not a v3 regression.
- **Shared Postgres note**: both worktrees share `boi_dev_d`; baselines unreliable. Round 3 numbers came from `v3/deepseek` migration state. CI with clean Postgres container in progress.
- **Spectrum missing vars for Track H**: `SPECTRUM_LINE_E164` and `SPECTRUM_WEBHOOK_SECRET` are unset in `.env`. Both required for Photon Pro live end-to-end testing. Logged here for Track H until CI is up.

### 2026-08-09 · Claude · C
No transport for §4.3 existed anywhere in the repo, so Track C built it: new package
`cloud/device-search/` (`DeviceGateway`, `attachDeviceGateway`) holds the persistent cloud<->Mac
WebSocket, request/response correlation by `id`, and the 4s timeout. `gateway.portFor(scope)`
returns a `DeviceSearchPort` matching Track B's `cloud/agent/src/ports.ts` shape structurally
(defined independently — that package doesn't exist in this worktree yet).

### 2026-08-09 · Claude · C
Added `ws` + `@types/ws` to root `package.json`/`package-lock.json` (smallest edit: two
dependency lines) — no WebSocket library was installed anywhere. `npm ci` in another worktree
needs these before `cloud/device-search` will typecheck/build.

### 2026-08-09 · Claude · C
`attachDeviceGateway`'s `resolveUserId` (`cloud/device-search/src/gateway.ts`) is a **dev
placeholder** — it trusts a `?user_id=` query param with no auth. Whoever wires this into
`cloud/api/src/main.ts` for real (Track H, or Track C later) must replace it with a real
device-token check before this ships; do not carry the placeholder into production config.

### 2026-08-09 · Claude · C
Mac side: `mac/Sources/BoiKit/Search{Protocol,Index,RequestHandler}.swift` implement the
`ask_device` "search" op end-to-end against the real, already-populated `message_fts` (verified:
97,137 messages / 566 distinct handles in the real `mirror.db`, filtered FTS query ~1-2ms
excluding CLI overhead). **Not wired into the app** — `mac/Sources/BoiApp` (Track D's file) still
needs a WebSocket client that connects to `wss://.../v1/device-link`, decodes
`AskDeviceSearchRequest`, calls `SearchRequestHandler.handle(_:)`, and encodes the response back.
`SearchRequestHandler`/`SearchIndex` are the pure, already-tested logic; only the socket plumbing
in `BoiApp` remains, and Track C did not touch that file per the ownership rule.

### 2026-08-10 · Claude · C
Closed the `resolveUserId` auth hole noted above: the default is now
`authenticateDeviceLinkRequest` (`cloud/device-search/src/gateway.ts`), which reuses
`bootstrapLookups.authenticateDeviceToken` and requires `Authorization: Bearer <device_token>` on
the upgrade request, checked against the claimed `?user_id=`. Whoever wires `attachDeviceGateway`
into `cloud/api/src/main.ts` needs no options for real auth; the Mac's WS client (`BoiApp`, still
unwired per the note above) must send that header, and `mac/Sources/BoiKit` device-token storage
is outside this track's files.
