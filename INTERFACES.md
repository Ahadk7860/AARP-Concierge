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
