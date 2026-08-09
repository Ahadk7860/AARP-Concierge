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
