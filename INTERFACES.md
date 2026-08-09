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

### 2026-08-09 · Claude · A
Landed `contracts/schema/chat_reply.v2.json` (adds `kind: "open"`, evidence-refs replacing
licenses for it) and `chat_route.v1.json` (`{lane, intent?}`), each with a differential test
against ajv from day one, per orchestrator instruction. Zod mirrors in `cloud/api/src/schemas.ts`;
`lane` (router outcome) and `intent` (§4.2a cache key) are kept as distinct, non-conflatable
fields — `intent`'s enum must be hand-kept byte-identical to `cloud/shared/src/intents.ts`.
