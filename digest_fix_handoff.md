# Digest 400 — Root Cause Found, Fix Applied Locally. Your Job: Ship and Verify.

You have prior context on this blocker. Read this before touching anything — the
diagnosis in `digest_fail_report.md` is **wrong** and following it will re-break the fix.

## The actual root cause

`POST /v1/digest` returned `400 validation` because the **server's zod mirror drifted
from the frozen contract**. The Mac app was always correct.

`contracts/schema/digest.v2.json` — the arbiter per CONTRACTS.md §1 — permits `unknown`
in both `understanding.register` and `understanding.relationship_kind`. The zod mirror in
`cloud/api/src/schemas.ts` omitted it from both. On the user's real 420-relationship
digest that is **554 validation errors**, not the ~5 the report guessed:

```
285 | relationships.[].understanding.register          :: received 'unknown'
269 | relationships.[].understanding.relationship_kind :: received 'unknown'
```

Two corrections to the prior report, both load-bearing:

1. **It was never only `relationship_kind`.** `register` is broken identically and
   outnumbers it. Any fix that touches only `relationship_kind` trades a 269-error 400
   for a 285-error 400. That is why the previous loop never converged.
2. **`.unknown → .other` in Swift was destructive and has been reverted.** The contract
   and the Swift comments both state the distinction deliberately: `other` = classified,
   fits no named kind; `unknown` = below the evidence threshold. Collapsing them makes
   269 relationships assert a finding the app never made, in a codebase whose stated rule
   is "degrade, never fabricate."

**Do not re-apply any Mac-side change. Do not rebuild the DMG. This ships server-side.**

## What is already done (verify, do not redo)

| File | Change |
|---|---|
| `cloud/api/src/schemas.ts` | `"unknown"` added to `understandingSchema.register`, `understandingSchema.relationship_kind`, `contextualExemplarSchema.register` |
| `cloud/shared/src/contracts.ts:44,48` | same widening in `ContextualExemplar["register"]` and `RelationshipUnderstanding["relationship_kind"]` |
| `mac/Sources/BoiKit/DigestBuilder.swift:250` | reverted to `case .unknown: return .unknown` |
| `cloud/api/src/differential.test.ts` | added `digestV2Cases()` + `ajv.addSchema(v1, "digest.v1.json")` + `it("agrees on every digest v2 case")` |

Confirm all four are present before proceeding:

```bash
cd /Users/skylerluk/Dev/boi-imessage && git diff --stat cloud/api/src/schemas.ts cloud/shared/src/contracts.ts cloud/api/src/differential.test.ts && git diff mac/Sources/BoiKit/DigestBuilder.swift
```

`DigestBuilder.swift` must show **only a comment change** — if the `case .unknown:` line
itself differs from `return .unknown`, the revert was lost. Restore it.

## Why the test suite never caught this

`differential.test.ts` exists precisely to catch mirror drift and missed it on two axes:
`compile()` was only ever handed `digest.v1.json` and `voice_pack.v1.json` — **digest.v2
was never differentially tested at all** — and every probe removed keys, never varied enum
members. The new `digestV2Cases()` enumerates enum members **from the frozen schema**, so
a member added to `digest.v2.json` later is covered without editing the test. Keep that
property; do not replace it with a hand-written member list.

## Step 1 — Verify locally before deploying

```bash
cd /Users/skylerluk/Dev/boi-imessage && npx vitest run cloud/api/src/differential.test.ts cloud/api/src/schemas.test.ts
```

Then prove the new test is not vacuous — this must FAIL, then be restored:

```bash
cd /Users/skylerluk/Dev/boi-imessage && cp cloud/api/src/schemas.ts /tmp/schemas.bak && sed -i '' 's/"dormant_close", "other", "unknown"/"dormant_close", "other"/' cloud/api/src/schemas.ts && npx vitest run cloud/api/src/differential.test.ts; cp /tmp/schemas.bak cloud/api/src/schemas.ts
```

Expected failure line: `digest.v2 understanding.relationship_kind = unknown: frozen schema says VALID, zod says invalid`.

Then validate the user's real digest against the built schema. **`tsc --noEmit` does not
update `dist/`** — the previous session was misled by exactly this and re-ran a stale
validator. You must emit:

```bash
cd /Users/skylerluk/Dev/boi-imessage && npx tsc -p tsconfig.json --outDir dist && node -e 'import("./dist/cloud/api/src/schemas.js").then(async m=>{const d=JSON.parse((await import("node:fs")).readFileSync(process.env.HOME+"/Library/Application Support/Boi/out/digest_v2.json","utf8"));const r=m.digestV2Schema.safeParse(d);console.log(r.success?"VALID":r.error.issues.length+" issues");})'
```

Must print `VALID`.

## Step 2 — Pre-existing failures, do not chase

Full suite is **698 passed / 10 failed**. All 10 are pre-existing and unrelated —
confirmed by stashing the fix and reproducing them identically:

- `cloud/db/src/schema.test.ts` (6) — needs a live Postgres
- `cloud/e2e/src/e2e.test.ts` (4) — card rendering
- `cloud/phase2-runtime/inbound-adapter.test.ts` — fails to collect; uncommitted work from a prior session

Do not fix these as part of this change. Do not let them block the deploy.

## Step 3 — Commit

Attribute to `Skyler Luk <skylerluk@gmail.com>`. Stage **only** these four files —
`.handoff/STATE.md`, `mac/Sources/BoiKit/Uploader.swift`, `cloud/phase2-runtime/inbound-adapter.test.ts`,
and `cloud/register-device.mjs` are unrelated in-flight work and must not ride along:

```bash
cd /Users/skylerluk/Dev/boi-imessage && git add cloud/api/src/schemas.ts cloud/shared/src/contracts.ts cloud/api/src/differential.test.ts mac/Sources/BoiKit/DigestBuilder.swift && git status --short
```

Commit message should say the mirror drifted from the arbiter, name both fields, and note
that digest.v2 had no differential coverage.

## Step 4 — Deploy and verify end to end

Railway service `boi-api-production` builds from `Dockerfile` (`railway.toml`). After the
deploy is healthy (`/readyz`), re-run the Mac sync with the **existing** `/Applications`
binary — no rebuild:

```bash
BOI_USER_ID=usr_fc114fd4ec8bf544 BOI_DEVICE_TOKEN=usr_fc114fd4ec8bf544.jufNXNlYHIxrr11I6V3o23VoEy1YWwpRaH7XLjpT8ps /Applications/Boi.app/Contents/MacOS/Boi --sync --force
```

Success = `POST /v1/digest` returns 2xx. If it still 400s, **do not guess** — dump the
full issue list with the Step 1 validator against the freshly written digest and read the
actual paths. The 16 voice packs failing `redaction_failed` are a separate known issue and
are not a regression.

## Step 5 — Known downstream issue, decide deliberately

`cloud/chat/src/draft.ts` consumes digest.v2 directly and has the **same drift**:

- L7 `REGISTER` and L10 `RELATIONSHIP_KIND` both omit `"unknown"`
- `parseUnderstanding()` requires `boundedText(value.open_thread, 140)`, but `boundedText`
  (L122) demands `typeof value === "string"` while the frozen schema declares
  `open_thread` as `["string","null"]`

Both make `parseUnderstanding` return `null`, so `selectDraftSource` returns `null` and no
draft is produced — for 285 of 420 relationships on the real digest.

This is **not** a blanket-widen. Declining to draft below the evidence threshold may be
intended; the templates are `acknowledge_open_thread` / `defer_open_thread`, so a
relationship with no open thread genuinely has nothing to acknowledge. The bug is that
this is expressed as a *parse rejection*, indistinguishable from a malformed document.
Accept the value into the vocabulary and skip with an explicit logged reason instead.
Nothing currently checks `draft.ts`'s hand-written vocabularies against
`contracts/schema/` — consider extending the differential to cover them.

Confirm with the user before changing draft behavior; it is a product decision, not a
mechanical fix.
