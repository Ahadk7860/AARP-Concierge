# Track A — Prompt 02: A durable local mirror that never loses a backfilled message

**Depends on:** 01 (consumes the reader; same files)

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the reader from `01` exists and can enumerate rows. The mirror is the durable
record — after three years, leaving Boi means losing your own history, and no competitor
can import it. Treat it as versioned storage, not a disposable cache.

`03` (typedstream) is independent of this prompt and can run first if this one stalls.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

Rows read from `chat.db` land in a local mirror that is correct across backfill, checkpointing, and repeated runs.

## Scope

**In scope:**

- `/tmp/boi-a/mirror.db`: SQLite with FTS5 over message text, schema versioned from day one.
- Dedup by `guid`, always. `chat.db` is eventually consistent and occasionally lossy — never treat it as authoritative or monotonic.
- **The watermark:** advance on ROWID for new rows, **and** re-scan a trailing 30-day window every run, deduping by `guid`. Thirty days because that is iMessage's server-side queue depth.
- Schema version detection on `chat.db`, failing loudly to a known-good column subset rather than silently producing wrong numbers.
- Idempotency: two runs over the same input produce identical mirror contents.

**Explicitly out of scope for this prompt:**

- Metrics — that is `04`.
- Vector embeddings. FTS5 now; the same store takes vectors later.
- Any pruning or retention logic in the mirror. The mirror keeps everything it has ever seen, including rows `chat.db` has since dropped. That is the point.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** none consumed. `CONTRACTS.md` § 6 for time handling: ISO 8601 UTC at every boundary.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `boi-cli sync --db /tmp/boi-a/chat.db --mirror /tmp/boi-a/mirror.db` populates the mirror and prints rows inserted and rows skipped as duplicates
- [ ] **Idempotency:** running `sync` twice reports zero new rows the second time, and `SELECT count(*)` on the mirror is unchanged
- [ ] **The backfill test — this is the one that matters.** A test inserts a message into the fixture with a *new* ROWID and a date 60 days old, re-runs `sync`, and asserts the row appears in the mirror. A ROWID-only watermark fails this test; that failure is the whole point of the trailing re-scan.
- [ ] **The durability test:** a test deletes a row from the fixture `chat.db`, re-runs `sync`, and asserts the row is still present in the mirror
- [ ] A test asserts two different `chat.db` rows with the same `guid` produce exactly one mirror row
- [ ] FTS5 search returns the expected row: a test inserts known text and finds it via the FTS index
- [ ] Schema-version detection: a test corrupts an expected column name and asserts the reader fails loudly with a named error rather than returning zero rows
- [ ] Existing tests still pass: `swift test --package-path mac` exits zero
- [ ] Lint passes: `swift build --package-path mac -Xswiftc -warnings-as-errors` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh a` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- full `swift test` output with the backfill and durability tests named
- the two `sync` runs showing the idempotency counts
- `sqlite3 /tmp/boi-a/mirror.db '.schema'` output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 02 mirror — <what changed>"
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
