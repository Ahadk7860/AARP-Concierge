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
