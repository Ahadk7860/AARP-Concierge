# Track E/F/G — Required Fixes Before Merge

**Reviewed**: `v3/deepseek` @ `cfef626` vs `main` (~1,650 lines, E1–E9, F1–F4, G0–G3).
**Verdict**: do not merge yet. Two blocking defects mean the branch cannot deploy, plus four
should-fix items. The design thinking is sound — the SQL and the wiring are not.

Findings were verified by reading the code and running `npx tsc --noEmit` / `npx vitest run`,
not inferred from commit messages. Where a fix is non-trivial, that is said explicitly.

---

## BLOCKING 1 — The v3 migrations cannot apply to Postgres at all

`cloud/db/migrations/017_v3_persons_identities_interactions.sql` (also 018, 019) declare a
bare single-column primary key on a hash-partitioned table:

```sql
person_id  text primary key,       -- line 15
...
) partition by hash (user_id);     -- line 18
```

Postgres requires every unique/PK constraint on a partitioned table to include the partition
key. Running the suite fails inside `migrate.ts` with:

```
error: unique constraint on partitioned table must include all partitioning columns
```

Affected: `persons.person_id`, `identities.identity_id`, `interactions.interaction_id`,
`outcomes.outcome_id`, `memories.memory_id`, `corrections.correction_id`,
`draft_edits.edit_id` (018), `open_loops.loop_id` (019).

**This is not entirely your error — the spec is wrong.** `V3_ARCHITECTURE.md` §4.1 literally
writes `person_id text primary key` while the same section's closing line mandates the
hash-partition discipline. You followed the frozen spec faithfully. The safety net that would
have caught it, `schema.test.ts`, requires Postgres and sits on the documented
do-not-chase list, so it never ran.

### What to do

1. **Fix `V3_ARCHITECTURE.md` §4.1 first.** You own that section. Change every affected table
   to a composite PK including the partition key, matching the convention every existing table
   already uses (`primary key (user_id, device_id)`, `primary key (user_id, contact_id)`,
   `primary key (user_id, code)`). Log the amendment in `INTERFACES.md`.
2. **Then fix the migrations to match.**
3. **Then fix the fallout in `cloud/db/src/repository-v3.ts`.** This is the part that is not a
   patch: that file's upserts use `on conflict (person_id)`, `on conflict (loop_id)`,
   `on conflict (identity_id)` and similar, all of which depend on exactly the single-column
   uniqueness Postgres is rejecting. Every one needs to become the composite target. Please
   re-derive these rather than mechanically appending `user_id` — some may want a different
   conflict target or an explicit unique index.
4. `identities` already has `unique (user_id, source, handle)`, which is correctly composite —
   use it as the model.

---

## BLOCKING 2 — Digest ingestion silently drops every upload

`cloud/api/src/routes/ingest.ts:149-164`. The route enqueues and returns `202` on success.
`insertDigest` now runs **only if `enqueue` throws**:

```ts
try {
  await enqueue("ingest", principal.scope, { digest_id, digest, first, received_at });
  return reply.code(202).send({ digest_id, received_at });   // <-- data never inserted
} catch (_enqErr) {
  // fall through to inline processing                        // <-- only path that persists
}
```

And there is **no consumer**. `grep -rn "dequeue(" cloud` outside `queue.ts` returns zero
matches — no worker, no cron, no route. Every digest the Mac uploads is written to `jobs` and
never read again. The client receives a healthy `202` while the user's data quietly stops
updating.

The safety property is inverted: the system persists data only when the queue is broken.

`precomputeAll` / `invalidatePrecomputed` in `cloud/db/src/precompute.ts` have the same
problem — zero call sites anywhere. The commit message "G1-G3 — compute + invalidate on
ingest" describes wiring that does not exist.

### What to do — pick one, do not ship as-is

- **Option A (safer, recommended):** revert `ingest.ts` to insert inline, and land the queue
  as dead-but-tested infrastructure until a worker exists. `V3_ARCHITECTURE.md` §5 puts the
  enqueue switch at ~1k users; there is no need to take the risk now.
- **Option B:** build the worker in this branch — a process that calls `dequeue`, runs
  `insertDigest` + `precomputeAll`, calls `completeJob`, and handles failure/retry/poison
  messages. Then prove it with a test that enqueues and asserts the row lands.

Either way, add a test asserting that a successful upload results in a persisted digest. That
single test would have caught this.

---

## SHOULD-FIX 3 — R2 payloads are written unencrypted

`cloud/db/src/digest-r2.ts:22` writes `JSON.stringify(payload)` straight to R2. Nothing in
`r2.ts`, `r2-deletion.ts`, or `digest-r2.ts` references `CONTACT_KEY_ENVELOPE_MASTER_KEY`,
`HandleVault`, `TurnVault`, or `createHandleEnvelopeKeyProvider`.

`CONTENT_STORAGE.md` non-negotiable #2 requires envelope encryption — a per-user data key
wrapped by the master key, reusing the existing vault machinery. Nothing leaks today only
because this code is unwired; it becomes a real exposure the moment `storeDigestPayload` is
called from `main.ts`, which your own `INTERFACES.md` note tells the next person to do.

---

## SHOULD-FIX 4 — Nothing prevents R2 deletion from becoming the lie it was meant to fix

Credit where due: `deletePrefix` + `prefixExists` + `ResidualUserDataError` on nonzero residue
is the right pattern, correctly mirrors `ExternalCardStore`, and correctly runs after the
transaction commits. This part is good work.

The problem is that `installR2Store` has **zero production call sites** — only its own test
calls it. So `deleteR2Objects` always takes the `store === null` branch and reports success
without checking anything. That is fine today because no upload path exists. It becomes
exactly the failure `CONTENT_STORAGE.md` §1 warns about — verified success while the corpus
survives — the moment someone enables uploads and forgets the one `installR2Store(...)` line.

Note also that `BOI_R2_DIGEST_STORE` and `BOI_CONTENT_UPLOAD_ENABLED` appear only in comments;
neither is read anywhere.

**Add a startup interlock**: if content upload is enabled and no R2 deletion store is
installed, fail loudly at boot. Do not let that combination be reachable.

---

## SHOULD-FIX 5 — §4.4 was never amended for the `channel` parameter

`openBubbleSink` in `cloud/channel/src/progressive.ts` ships a required 4th field
`channel: Channel` that is not in the frozen §4.4 signature. The deviation is reasonable — a
sink must know where to send — and Track B has already aligned its stub to your shipped
signature, so nothing is broken.

But `V3_ARCHITECTURE.md` §4.4 still shows the old signature, and an `INTERFACES.md` entry
asked for the amendment mid-branch. Please update §4.4 to match what you shipped. The protocol
is that a frozen interface changes in the document first.

---

## SHOULD-FIX 6 — Test coverage

One test file was added across ~1,650 lines: `cloud/db/src/r2-deletion.test.ts` (good, but
narrow). Untested: the migrations (a schema test would have caught BLOCKING 1 immediately),
`repository-v3.ts` (~385 lines, zero coverage), `queue.ts` (`dequeue` has no caller to
exercise it), `precompute.ts`, `digest-r2.ts`. `ingest.test.ts` was not updated for the new
code path and currently gives no real coverage of `ingest.ts`.

Priority order: a migration/schema test, then `repository-v3.ts`, then the ingest path
end-to-end.

---

## NOTE 7 — `jobs` is not partitioned

`021_v3_queue.sql` creates `jobs` without `partition by hash (user_id)`, unlike every other new
v3 table and unlike §4.1's closing line. Deletion correctness is unaffected — it has `user_id`
and a cascading FK, so `catalog.ts`'s walk counts it. Either partition it for consistency or
log the deliberate exception in `INTERFACES.md`.

---

## NOTE 8 — For Track F: Sparkle updates may break security-scoped bookmarks

Track D's spike passed: `NSOpenPanel` → security-scoped bookmark → persist → relaunch →
resolve → read **from a LaunchAgent**, 7/7 on macOS 15.7.4. Boi can likely drop the Full Disk
Access requirement.

The relevant interaction for your F work: **security-scoped bookmarks bind to code-signing
identity, and a Sparkle update replaces the app with a re-signed binary.** Whether a saved
bookmark survives that is untested and is the most likely production failure mode. If it does
not, every auto-updated user silently loses `chat.db` access at their next scheduled sync.

`MessagesFolderAccess.swift` falls back to FDA and logs `access.bookmark_fallback_to_fda` on
every use. Treat that event as an update-health signal, and please add a post-update smoke
test to the Sparkle work.

---

## Summary

| # | Severity | Item |
|---|---|---|
| 1 | BLOCKING | Partitioned tables need composite PKs; fix §4.1, migrations, then `repository-v3.ts` |
| 2 | BLOCKING | Ingest enqueues with no consumer — every digest is silently dropped |
| 3 | SHOULD-FIX | R2 payloads unencrypted (CONTENT_STORAGE.md non-negotiable #2) |
| 4 | SHOULD-FIX | No interlock tying upload-enabled to R2-deletion-store-installed |
| 5 | SHOULD-FIX | Amend §4.4 for the `channel` param |
| 6 | SHOULD-FIX | Test coverage, starting with a schema test |
| 7 | NOTE | `jobs` not partitioned |
| 8 | NOTE | Sparkle re-signing vs security-scoped bookmarks (Track F) |

Blocking 1 and 2 must be fixed before merge. 3–6 should land before this is considered done.

Please re-request review after 1 and 2 — a fix to a blocking defect is exactly where a new
one hides, and the migration/`on conflict` rework is broad enough to deserve a second look.

---

# Review round 2 — `v3/deepseek` @ `b700f8d`

Verified by reading the code, not the summary.

## BLOCKING 1 — FIXED, verified

All eight tables in 017/018/019 now carry `primary key (user_id, <col>)`, and every
`on conflict` target in `repository-v3.ts` was updated to match: `(user_id, person_id)`,
`(user_id, source, handle)`, `(user_id, interaction_id)`, `(user_id, loop_id)`,
`(user_id, person_id, day)`, `(user_id, person_a, person_b)`, `(user_id, intent)`. That is a
complete sweep, not a partial one. §4.1 amended. Good.

## BLOCKING 2 — FIXED structurally, but UNPROVEN and with a residual leak

`ingest-worker.ts` exists, `startIngestWorker` is genuinely wired into `main.ts:597` with a
cleanup handler, and `dequeue` uses `for update skip locked` — so multiple API replicas can
poll without double-processing. That is the right implementation and better than asked for.

Two things remain:

**(a) There is still no test proving an upload persists.** The only test file in the entire
branch is `r2-deletion.test.ts`. The original brief asked specifically for "a test asserting
that a successful upload results in a persisted digest — that single test would have caught
this." It still would. Right now the fix for a silent-total-data-loss bug is verified by
reading alone, which is exactly the state that produced the bug.

**(b) A failed job is terminal, so data loss is now rarer rather than fixed.**
`ingest-worker.ts:68` marks a job `failed` and stops. No retry, no backoff, no alert, no
dead-letter handling. A transient Postgres blip during `insertDigest` permanently loses that
digest, silently — the same failure as before, just narrower. At minimum emit a loud log/metric
on `failed`; better, retry with backoff and an attempt counter before giving up.

## 5, 7 — FIXED

§4.4 now matches the shipped `openBubbleSink` signature including `channel`. The `jobs`
partitioning exception is documented deliberately rather than left silent.

---

## Answer to "tackle 3/4/6 now, or re-request review?"

Review first — that is this document. Then do them in **this order**, which is not the numeric
order:

1. **#6 first, narrowly scoped.** A schema/migration test (would have caught BLOCKING 1
   instantly) and one ingest test: enqueue → worker runs → digest row exists. Plus 2(a) above.
   Do this before anything else, because it is what validates the two blocking fixes you just
   made. Full coverage of `repository-v3.ts` can follow later.
2. **2(b)** — failed-job visibility. Small, and it closes the last silent-data-loss path.
3. **#4** — the startup interlock (upload enabled + no R2 deletion store installed → fail
   loudly at boot). Cheap, and it prevents the deletion lie from ever becoming reachable.
4. **#3** — R2 envelope encryption. The largest piece, and the least urgent in wall-clock
   terms because R2 is entirely unconfigured today (no Cloudflare account, no bucket, no
   credentials, `BOI_R2_DIGEST_STORE` unset). It must land before R2 is ever enabled, not
   before merge.

**Merge posture**: with 1 and 2 fixed, the branch is no longer undeployable. I would still want
item 1 above (the two tests) before merging, since both blocking fixes are currently unverified
by anything executable. #3 and #4 can land after merge provided R2 stays disabled.

# Review round 4 — the fix works; commit it, then two things

I ran your uncommitted fixes. **BLOCKING 2 is now proven fixed.**

```
✓ v3 ingest queue > enqueue → dequeue → insertDigest persists a digest row
  Tests  4 failed | 27 passed (31)
```

Your root cause was right: `base = params.length` had to be `base = params.length + 1`,
because SQL parameters are 1-based. That is the real bug, correctly found and correctly fixed.
**Commit it now** — it is the single most important fix on this branch and it is sitting
uncommitted in your working tree.

## 1. The duplicate-digest test — decide which side is wrong, do not just change the test

You wrote that it "fails because my duplicate scenario triggers a PK violation, not the
`DuplicateDigestError` path." Before you edit the test to expect a PK violation, answer this:
**what does a real duplicate upload do in production?**

- If a genuine re-upload of the same digest raises a raw PK violation rather than
  `DuplicateDigestError`, then the *code* is wrong, not the test. The worker will retry it
  three times and mark it `ingest_job_terminal_failure` — turning a harmless duplicate into a
  permanent failed job and log noise.
- If the code is right and only your test's setup is unrealistic, fix the setup.

Changing the assertion to match current behaviour is only correct in the second case. Say
which one it is and why.

## 2. The two deletion failures matter more than their count suggests

```
× the delete > is ONE raw statement, and the catalog says nothing survived it
× the delete > reports the tables it verified, enumerated from the catalog
```

These are the CCPA path. If they fail because your new v3 tables leave residue after
`deleteUser`, that is a data-deletion defect and it is severe. If they are inherited, they are
not yours. **Determine which, explicitly.** Do not assume they are pre-existing because they
were in the earlier failure count.

## 3. IMPORTANT — the local Postgres is shared, so all our baselines are unreliable

I ran `schema.test.ts` on `main` after running it on your branch. `main` now fails with:

```
AssertionError: jobs is not partitioned: expected undefined to be defined
AssertionError: expected 21 to be 23
AssertionError: expected [ 'briefs', 'contact_handles', …(10) ] to deeply equal [ …(22) ]
```

`jobs` is one of *your* v3 tables. It should not exist when `main`'s tests run. Both worktrees
use the same local `boi_dev_d`, so whichever branch migrates last leaves the database in its
own shape, and the next branch measures against contaminated state.

This is the same class of problem as the shared `/tmp/boi-a` Swift fixtures. It means the
"7 pre-existing failures on `main`" figure I gave in round 3 — and any local number either of
us quotes — cannot be trusted as a baseline.

**Do not chase the deletion failures against this database.** Use a fresh one: drop and
recreate `boi_dev_d`, migrate from your branch only, then re-run. State which database state
your numbers came from when you report them.

CI is being added now (Ubuntu plus a Postgres service container), which gives a clean database
per run and settles this permanently.

## 4. Not Photon Pro yet

Finish this branch first. The missing `SPECTRUM_LINE_E164` and `SPECTRUM_WEBHOOK_SECRET` are
real and they will block live end-to-end testing — but that is Track H's problem, and H cannot
start until this branch is green. Log the missing variables in `INTERFACES.md` for H and move
on. Do not switch tasks with an uncommitted critical fix in your tree.

---

# Review round 3 — `v3/deepseek` round-2 fixes

**I ran the tests. They fail.** This is not a code-reading objection.

## BLOCKING — the tests added to prove BLOCKING 1 and 2 do not pass

There is a local Postgres on this machine (`pg_isready` → accepting connections), so
`schema.test.ts` is runnable. Results:

| Branch | Tests | Passed | Failed |
|---|---|---|---|
| `main` (baseline) | 28 | 21 | 7 |
| `v3/deepseek` | 31 | 21 | **10** |

Three tests added, three new failures. **Zero of the new tests pass.** Named:

```
× v3 ingest queue > enqueue → dequeue → insertDigest persists a digest row
× v3 ingest queue > a duplicate digest is still a done job (not failed)
```

The first of those is precisely the test the round-1 brief asked for to prove digests are no
longer silently dropped. It fails. **BLOCKING 2 is still unproven.**

## BLOCKING — and the failure is a real bug in `upsertRelationships`

```
error: bind message supplies 21 parameters, but prepared statement "" requires 20
  at Module.scopedQuery       cloud/db/src/scope.ts:144
  at upsertRelationships      cloud/db/src/repository.ts:573
  at                          cloud/db/src/repository.ts:727
```

A parameter-count mismatch in the batch multi-row upsert from E3 — one of this branch's own
changes. The placeholder list and the bound-parameter array have drifted out of step by one
column. Any ingest that reaches `upsertRelationships` throws.

Note what this means in combination with the worker: an ingest job now dequeues, throws here,
retries three times, and lands in `ingest_job_terminal_failure`. The retry logic added in round
2 works correctly — it is faithfully retrying a call that cannot succeed. **Every digest would
still be lost**, just noisily now instead of silently. The round-2 fixes are individually sound
and collectively still broken.

## Note — the "do not chase `schema.test.ts`" guidance is masking real failures

`boi_remaining_work.md` lists this file as a pre-existing failure "needs Postgres." Postgres is
present and it fails for substantive reasons — 7 on `main` before this branch. That note has
been discouraging anyone from looking at the one test file that covers partitioning, catalog
enumeration and deletion verification. Whatever its original cause, it should be re-triaged
rather than inherited. It is the direct reason BLOCKING 1 shipped.

## What to do

1. Fix the `upsertRelationships` parameter/placeholder mismatch at `repository.ts:573`.
2. **Run `npx vitest run cloud/db/src/schema.test.ts` and paste the output.** Not a summary —
   the counts. The pass condition is 24 passed / 7 failed: your three new tests green, with
   the 7 pre-existing failures unchanged from `main`'s baseline.
3. Then triage those 7 pre-existing failures separately. Partitioning and catalog enumeration
   are exactly the coverage that would have caught BLOCKING 1.

Everything else in round 2 — migration 022 with `attempts`, `retryJob`, the boot interlock
refusing `BOI_R2_DIGEST_STORE` without `BOI_R2_DELETION_ENABLED=1`, and AES-256-GCM via the
existing `HandleVaultKeyProvider` with backward-compatible reads — looks right on inspection
and is good work. None of it is verifiable until the suite runs green.

## Correction on item 8

Round 2 records item 8 as "Track D's domain, not Track E/F/G." That is not right. Track D
proved bookmarks resolve from a LaunchAgent; it cannot test survival across a **Sparkle
update**, because Track F owns Sparkle, the packaging, and the signing/notarization flow that
produces the updated binary. The post-update smoke test belongs to Track F. Track D's
contribution is the signal to assert on: `access.bookmark_fallback_to_fda`.

---

## Item 8 (Track F, Sparkle) — unchanged and still open

Security-scoped bookmarks bind to code-signing identity; a Sparkle update re-signs the binary.
Track D's spike passed 7/7 on macOS 15.7.4, so Boi can likely drop Full Disk Access — but
bookmark survival across an app update is untested and is the most likely production failure.
Watch `access.bookmark_fallback_to_fda` as an update-health signal.
