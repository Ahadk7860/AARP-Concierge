# Track D — Prompt 01: A schema where delete is one operation

**Depends on:** none

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

This is the first prompt in the track. Nothing exists beyond the foundation commit: the
frozen `cloud/shared/src/contracts.ts`, `StubChannel`, and the fixtures. Worktrees share
neither untracked files nor installed dependencies, so per-worktree setup happens here.

Two properties in this prompt cannot be retrofitted once there is data. Everything after
it is comparatively cheap to change.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A migrated Postgres schema partitions every table by `user_id`, stores per-user salts, and makes deletion a single operation that provably leaves nothing behind.

## Scope

**In scope:**

- Per-worktree setup: `npm install`, `.env` from `.env.example` with your track's values, create `boi_dev_d`.
- Migrations at `cloud/db/migrations/`, forward-only, each reversible or explicitly marked not.
- `users`, `devices`, `relationships`, `voice_packs`, `digests`, `pairing_codes`, `briefs`, `messages_out`.
- **Hash partitioning by `user_id` on every table that holds user data.**
- `user_salt` generated at pairing, stored once, never rotated.
- **A delete that is one operation** and covers derived data.
- A repository layer with `user_id` as a required argument on every query — make it impossible to write a cross-user query by accident.

**Explicitly out of scope for this prompt:**

- The HTTP surface — that is `02`.
- Computing `contact_id`. The Mac does that; you store what arrives.
- Any table that would let two users' records be joined on a shared person. If you find yourself designing one, stop and report.

## Constraints

- **Paths you may modify:** `cloud/db/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `CONTRACTS.md` § 3 — the DDL there is the starting point, not a suggestion.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] Migrations run clean from empty against `boi_dev_d` and are idempotent on re-run
- [ ] **Every user-data table is partitioned by `user_id`** — a query against `pg_partitioned_table` proves it; paste the result
- [ ] **The delete test:** seed a user with a digest, relationships, voice packs and briefs; delete; then assert **zero** rows remain for that `user_id` in every table. Enumerate the tables from the catalog rather than a hard-coded list, so a table added later cannot be silently missed.
- [ ] **The cross-user test:** seed two users whose digests contain the same `display` name and assert no query in the repository layer can return both users' rows — and that the two `contact_id` values differ even for the same underlying person
- [ ] The repository layer requires `user_id`: `npm run typecheck` fails if it is omitted. Demonstrate with a deliberately broken snippet, then remove it.
- [ ] `user_salt` is generated with a CSPRNG, is at least 32 bytes, and is unique per user — asserted
- [ ] Existing tests still pass: `npm test -- cloud/api cloud/brief cloud/card cloud/db` exits zero
- [ ] Lint passes: `npm run lint && npm run typecheck` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh d` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

> Use `git diff --name-only main...HEAD`, not `git status`. After the mandated commit
> `git status` is empty and the check passes silently — leaving the entire ownership
> model unguarded. `scripts/check-ownership.sh` does this correctly.

Every criterion above is checkable using **only the foundation stubs and this track's
own code.** Nothing here requires another track's real implementation.

## Self-verification — do this before reporting

1. Run every item in the Definition of Done yourself.
2. If any item fails, fix it and run the whole checklist again.
3. Repeat until every item passes, or until you are genuinely blocked in a way you
   cannot resolve within this prompt's scope.
4. Only then report.

### Frozen anchors

You may not modify, skip, delete, or weaken any existing test, assertion, lint rule,
or type constraint in order to pass this checklist. You may not lower a threshold, add
an exception, loosen a type, or mark a test pending or skipped.

If a check must change for a legitimate reason, stop. Record it in `NOTES.md` under
`## Deviations from the plan`, and report it. Do not change it and continue.

**A green checklist bought by weakening a check is a failure reported as a success.**

A fresh-context reviewer will read the full diff specifically for bent anchors when
this track completes.

Summary: **a green checklist bought by weakening a check is a failure reported as a
success.** You are grading your own work here, and the easiest way to turn a criterion
green is to weaken the criterion. A fresh-context reviewer reads the full diff for bent
anchors when this track completes.

## Evidence to include in your report

Claims are not accepted; artifacts are. Produce:

- migration output from empty
- the `pg_partitioned_table` query result
- the delete test output, showing the enumerated table list and zero rows
- the typecheck failure for the missing `user_id`, then the passing run
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/db/
git commit -m "track-d: 01 schema — <what changed>"
```

Commit even if the next prompt continues the same file. Every stage gets a commit.

## Stop

After committing, **stop and report.** Do not begin the next prompt.

> **Do not merge this branch. Do not open a pull request. Do not touch the base
> branch. Stop and report when the track is done.** Full rule:
> `prompts/MERGE-POLICY.md`.

If you are blocked rather than done: commit what works with the blocker named in the
message, write it into `NOTES.md` under `## Blockers`, and report. A reported blocker
is a legitimate outcome. A false green is not.

Wait for the user's go-ahead.
