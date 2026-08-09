# Boi — Remaining Work After the Digest Blocker Cleared

You have prior context. This file is the authoritative state as of 2026-08-08 16:30 UTC.
Read the "Do not undo" section before editing anything.

## Verified working (do not re-litigate)

The full pipe ran end to end and produced a real answer:

- `POST /v1/digest` → **202**, 1,202,694 bytes, 420 relationships
- Voice packs: 159 accepted, 15 rejected (`redaction_failed`)
- Inbound iMessage → scope resolved → `latestDigest` hit → `runClosedChat` → delivered

Observed reply: `"+19202659901 had an open question at the last sync. … As of Aug 8, 2026 at 4:07 PM UTC."`

**This proves the pipeline, not the product.** Three of the four fixes that got us here were
manual UPDATE/DELETE statements against production. Only #1 below is fixed in the repo. A new
user today reproduces failures #2 and #3 exactly.

## Do not undo

1. **Do not** re-apply `case .unknown: return .other` in
   `mac/Sources/BoiKit/DigestBuilder.swift:250`. `contracts/schema/digest.v2.json` permits
   `unknown` in both `understanding.register` and `understanding.relationship_kind`. The
   server's zod mirror was the drifted party and has been corrected. Collapsing `unknown`
   into `other` fabricates a finding the app never made.
2. **Do not** "simplify" the enum probe in `cloud/api/src/differential.test.ts` into a
   hand-written member list. It is driven by the frozen schema on purpose so new members are
   covered without editing the test.
3. `digest_fail_report.md` is **superseded and wrong**. Its diagnosis (Swift-side enum
   mapping, stale binary) was not the cause. Delete it or mark it obsolete.

---

## P0 — DONE. `rememberSpace` poisoned a user permanently on first-send failure

**Fixed in `cloud/channel/src/spectrum-channel.ts`.** The space id is now persisted only
after `send` resolves, and a `Target not allowed for this project` rejection calls the new
`forgetSpace` hook so a corrected handle can recover on the next send. Wired to
`users.channel_space_id` via `forgetSpectrumSpace` in `cloud/api/src/main.ts`.

Four regression tests in `cloud/channel/test/spectrum-channel.test.ts`; two of them fail
against the old code, verified by stashing the source. The transient-failure test exists to
stop an over-eager fix from clearing the space on an ordinary timeout, which would re-key a
conversation the user can see.

Original description retained below.

---

`cloud/channel/src/spectrum-channel.ts:79-90`:

```ts
const { handle, spaceId } = await this.options.spaceFor(msg.user_id);
const space = spaceId === null
  ? await this.options.port.createSpace(handle)
  : await this.options.port.getSpace(spaceId);
if (spaceId === null && this.options.rememberSpace !== undefined) {
  await this.options.rememberSpace(msg.user_id, space.id);   // ← persisted BEFORE send
}
const result = await this.options.port.send(space, parts).catch(...)  // ← may fail
```

The space id is written to `users.channel_space_id` before delivery is confirmed. When the
send then fails, the bad space is permanent: every later send takes the `getSpace(spaceId)`
branch and re-targets the original handle. Correcting `users.phone_e164` afterwards does
nothing, because the space id encodes the old target.

Observed in production: `users.channel_space_id` held the literal string
`any;-;+15550009998` — the placeholder number — while `phone_e164` was already corrected to
the real number. Every reply died with
`[spectrum-imessage] Target not allowed for this project`, swallowed by the `route_error`
catch in `cloud/phase2-runtime/compose-runtime.ts:74`, so the user got **silence**.

**Fix**: persist only after `send` resolves. Additionally, on the
`Target not allowed for this project` branch (`spectrum-channel.ts:98`), clear the stored
space so a corrected handle can self-heal.

**Test**: a send that throws must leave `channel_space_id` NULL; a subsequent send with a
corrected handle must call `createSpace`, not `getSpace`. Assert on the port mock's call log.

---

## P1 — PARTIALLY DONE. Identity split: nothing binds the digest user to the texting user

**Implemented as a loud warning, not a rejection.** `unroutableHandle` in
`cloud/api/src/routes/ingest.ts` detects NANP area code 555 and the reserved 555-01xx block,
and `/v1/digest` now logs `digest.unreachable_user` naming the number and the consequence.
Five edge tests in `cloud/api/src/unroutable.test.ts`.

**Why warn and not reject** — and this reverses what the earlier draft of this file said.
`phone_e164` is `not null unique` with a shape check (`001_identity.sql:20,28`), so the NULL
case the original plan assumed is impossible; the only reachable case is a well-formed but
unroutable number. And the test suite uses the reserved 555 ranges throughout on purpose
(`ingest.test.ts`, `e2e`, `main.test.ts`). Rejecting would have failed real uploads to guard
against a seeding mistake. If you want a hard failure, gate it on an env flag for dev/staging
rather than making it unconditional.

**Still open**: nothing prevents `AutoSetupUserCreator` from forking a second user. The
warning surfaces the condition at upload time; it does not stop the fork at text time.

Original description retained below.

---

The root cause of the "I don't have a recent digest" loop, repaired by hand in prod but
**not fixed in code**.

Two independent identity paths that never check each other:

- **Upload**: the Mac sends whatever `BOI_USER_ID` is in its `.env`. Devices were seeded by
  raw SQL / `cloud/register-device.mjs` (which hardcodes yet another id, `usr_phase2_stream`).
- **Inbound**: `cloud/phase2-runtime/inbound-adapter.ts:99` → `HandleUserResolver` →
  `findUserIdByHandle` (`cloud/db/src/repository.ts:366`), which is purely
  `select user_id from users where phone_e164 = $1`.

`createUser` (`cloud/db/src/repository.ts:166`) mints a **fresh random** `newUserId()`. So
when an unrecognized number texts, `AutoSetupUserCreator`
(`cloud/phase2-runtime/inbound-adapter.ts:164`) creates a *second* user bound to the phone,
with zero digests. `latestDigest` is `user_id`-scoped, so the two can never meet.

Production state that caused it:

```
usr_fc114fd4ec8bf544 | +15550009998   | 1 digest   ← seeded by hand, placeholder phone
usr_HPwjPmMvcJEUTKJD | +15108906637   | 0 digests  ← auto-created from the real phone
```

**Fix — pick one and write it down:**

- (a) Reject at ingest: `POST /v1/digest` should refuse (or loudly warn) when the target user
  has no reachable handle — no `phone_e164`, or one matching a reserved/test pattern such as
  `+1555…`. Today it returns 202 for a user nobody can text, which is what let a placeholder
  sit in prod undetected until first contact.
- (b) Refuse auto-setup when the handle would create a second user while a device is already
  registered elsewhere, and surface a pairing flow instead.

(a) is the smaller change and catches the failure at the moment it is introduced. Do both if
time allows. **Do not** just delete the test rows and call it fixed.

**Test**: ingest for a user with NULL `phone_e164` must not return 202. Auto-setup for a
handle whose number already owns a digest under a different `user_id` must not silently fork.

---

## P2 — INSTRUMENTED, NOT FIXED. Display names render as raw phone numbers

**Answered in part: the fallback itself is deliberate architecture, not a defect.**
`ContactResolver.Identity.display` (`ContactResolver.swift:25`) documents it outright — the
AddressBook name when there is one, "otherwise the handle itself, because a digest that says
'unknown' for half the ranking is worse than one that says a phone number." A reply naming
`+1920…` is therefore not evidence of a bug on its own.

**What remains genuinely unknown** is whether the directory we bound to was the right one.
Added `AddressBookDirectory.survey()` (`ContactResolver.swift`) plus two structured log
events emitted once per run from `SyncRun.swift`:

- `contacts.source` — one line per candidate AddressBook with its `record_count`
- `contacts.resolution` — `directory_records`, `relationships`, `unresolved`

Run a sync and read `~/Library/Application Support/Boi/boi.log`. **Two sources with one thin
winner confirms the `discover()` first-non-empty bug; one source with a plausible record
count means 328/420 is honest output** and the fix is a presentation decision, not a resolver
change. Do not change resolution behavior before reading those numbers — a normal shell
cannot stat that directory (TCC "Operation not permitted"), which is why this is logged from
inside the app instead of checked from outside.

Original description and the leading hypothesis retained below.

The delivered reply named `+19202659901` instead of a person. The server is **correct**:
`cloud/chat/src/reply.ts:122` uses `claim.display`. The bad data originates on the Mac.

Measured on the real digest: **328 of 420** relationships have a `display` that is a raw
phone number or email.

```bash
python3 -c "
import json,re
d=json.load(open('$HOME/Library/Application Support/Boi/out/digest_v2.json'))
rs=d['relationships']
print(sum(1 for r in rs if re.match(r'^\+?[0-9][0-9\- ()]{6,}$', r['display'].strip())), 'of', len(rs))
"
```

Some names DO resolve (~92), so the AddressBook was read — this is partial resolution, not
total failure.

**Leading hypothesis**, `mac/Sources/BoiKit/ContactResolver.swift:291-298`:

```swift
for path in defaultPaths(home: home) {
    if let directory = read(path: path), directory.recordCount > 0 { return directory }
}
```

`defaultPaths` walks `Library/Application Support/AddressBook/Sources/*` in `.sorted()`
order and `discover()` returns the **first source with any records at all**. A Mac with both
a small local source and a large iCloud source will silently bind to whichever sorts first.
The correct behavior is probably to merge all sources, or select the one with the most
records — not first-non-empty.

**Verify before changing**: enumerate every `AddressBook-v22.abcddb` under
`~/Library/Application Support/AddressBook/Sources/` and print `recordCount` for each. If one
source has thousands and another has a handful, the hypothesis is confirmed. If there is only
one source and it genuinely contains ~92 of these handles, then 328 unresolved is **honest
output** for a large iMessage history (businesses, group members, one-off numbers) and the
right fix is a product decision about how to present an unnamed contact — not a resolver
change.

Note: a normal shell cannot read that directory (TCC "Operation not permitted"). Run the
check from a process with Full Disk Access, or via the Boi binary.

---

## P3 — `draft.ts` has the same enum drift that caused the 400

`cloud/chat/src/draft.ts` consumes `digest.v2` directly but keeps its own hand-written
vocabularies, which nothing validates against `contracts/schema/`:

- L7 `REGISTER` and L10 `RELATIONSHIP_KIND` both omit `"unknown"`
- `parseUnderstanding` requires `boundedText(value.open_thread, 140)`, but `boundedText`
  (L122) demands `typeof value === "string"` while the frozen schema declares `open_thread`
  as `["string","null"]`

Either makes `parseUnderstanding` return `null`, so `selectDraftSource` returns `null` and no
draft is produced — for 285 of 420 relationships on the real digest.

Declining to draft below the evidence threshold may be **intended**. The defect is that it is
expressed as a parse rejection, indistinguishable from a malformed document. Accept the value
into the vocabulary and skip with an explicit logged reason. Confirm with the user before
changing draft behavior — it is a product decision.

---

## P4 — Lower priority, known

- **15 voice packs `redaction_failed`.** Pre-existing, unrelated to this work. 159/174
  succeed. Diagnose separately.
- **P1.5 — `Uploader.swift` DotEnv change breaks the Swift test suite. Fix or revert it.**
  Not merely "untested" as previously recorded: it makes the code read the developer's real
  `~/Library/Application Support/Boi/.env`, so tests asserting "no identity is configured"
  pick up live credentials and fail. Demonstrated by stashing that one file:

  ```
  with the change:     TokenStoreTests — Executed 6 tests, with 3 failures
  without the change:  TokenStoreTests — Executed 6 tests, with 0 failures
  ```

  Failing assertions read `DeviceIdentity(user_id: "usr_fc114fd4ec8bf544", …)` and
  `Configuration(baseURL: https://boi-api-production.up.railway.app …)` where `nil` was
  expected — the real values, from the real file, inside a unit test. The same leak takes
  `SyncRunUploadTests.testAnUnconfiguredMacRunsLocallyAndUploadsNothing` with it: the
  "unconfigured" Mac uploads.

  The fix is to make the search root injectable and have tests point it at a temp dir, not
  to delete the tests. Until then this change should not be committed.
- **`route_error` swallows the failure.** `compose-runtime.ts:74` catches, logs, and returns
  nothing, so a delivery failure is indistinguishable from silence to the user. Consider a
  fallback reply or an operator alert.
- **`cloud/register-device.mjs` hardcodes `usr_phase2_stream`**, a third user id unrelated to
  either real one. Parameterize or delete it.
- **Prod rows to clean**: `usr_Bq3vt2JvVIZBId6n`, `usr_7jPRoE0mXKDRG5eF`,
  `usr_1O8U52wkcNcxOam9` are test fixtures with `+1415555…`/`+1555555…` numbers.
  `usr_rFjC0YApTZ5IFj5Y` holds `+16465792868` — the Spectrum line itself, which is almost
  certainly wrong and worth understanding before deleting.

---

## Pre-existing test failures — do not chase

TypeScript: **707 passed / 10 failed** (was 698/10 — the 9 new tests are the P0 and P1
regressions above). All 10 failures predate this work; confirmed by stashing the fix and
reproducing them identically.

- `cloud/db/src/schema.test.ts` (6) — needs a live Postgres
- `cloud/e2e/src/e2e.test.ts` (4) — card rendering
- `cloud/phase2-runtime/inbound-adapter.test.ts` — fails to collect; uncommitted prior-session work

Swift: **365 tests, 11 failures** as the tree stands. Attributed by stashing
`Uploader.swift` and re-running the whole suite:

| | failures |
|---|---|
| current tree | 11 |
| without the DotEnv change | **7** |

So **4 are caused by the uncommitted DotEnv change** (P1.5 above) and 7 are pre-existing
environmental: `AppBundleTests` needs a bundle built by `mac/scripts/build-app.sh`, and
`TypedStreamTests` needs a fixture at `/tmp/boi-a/typedstream-fixtures.json`. The
`ContactResolver`/`SyncRun` logging added here contributes **zero** failures — the 7-failure
baseline was measured with those changes in place.

## Uncommitted files

`cloud/api/src/schemas.ts`, `cloud/shared/src/contracts.ts`,
`cloud/api/src/differential.test.ts`, `mac/Sources/BoiKit/DigestBuilder.swift` are the digest
fix — commit as one unit, attributed to `Skyler Luk <skylerluk@gmail.com>`. `.handoff/STATE.md`,
`mac/Sources/BoiKit/Uploader.swift`, `cloud/phase2-runtime/inbound-adapter.test.ts`, and
`cloud/register-device.mjs` are unrelated in-flight work — do not let them ride along.

## Definition of done

A user who has never run Boi can: install, grant FDA, sync, text the line, and get an answer
naming real people — **without any manual SQL**. Until P0 and P1 are code, that is not true,
and the current success depends on hand-repaired production rows.
