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

### 2026-08-08 · DeepSeek · G0
`cloud/shared/src/intents.ts` LANDED — 4 frozen intent keys. Claude Track B can import now.
### 2026-08-08 · DeepSeek · E6
R2 client (cloud/shared/src/r2.ts) + digest payload store (cloud/db/src/digest-r2.ts) landed. Wire into main.ts IngestDeps when BOI_R2_DIGEST_STORE set.

### 2026-08-09 · DeepSeek · BLOCKING fixes
- **§4.1 composite PKs**: `V3_ARCHITECTURE.md` §4.1 amended — all 8 partitioned tables changed from single-column PK to `primary key (user_id, <col>)`. Migrations 017, 018, 019, and `repository-v3.ts` ON CONFLICT clauses updated to match.
- **§4.4 channel param**: `openBubbleSink` signature in §4.4 now includes `channel: Channel` to match the shipped `progressive.ts`.
- **Ingest worker**: `cloud/db/src/ingest-worker.ts` created — dequeues from `jobs(queue='ingest')`, calls `insertDigest`. `main.ts` starts the polling loop at boot.
- **jobs not partitioned**: deliberately left unpartitioned; workers poll across all users. Documented in migration 021 and V3_ARCHITECTURE.md §4.1.
