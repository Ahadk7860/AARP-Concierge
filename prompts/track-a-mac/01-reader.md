# Track A — Prompt 01: Read chat.db without freezing the corpus

**Depends on:** none

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

This is the first prompt in the track. Nothing exists yet beyond the foundation commit:
`mac/Package.swift`, the frozen `mac/Sources/BoiKit/Contracts.swift`, one passing test
in `mac/Tests/`, and the fixture generator in `scripts/`. Worktrees share neither
untracked files nor installed dependencies, so per-worktree setup happens here.

What comes after: the local mirror (`02`) and the typedstream decoder (`03`) both build
on the reader you write here. Do not write either of them yet.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A `boi-cli scan` command opens `chat.db` read-only, reads messages including rows sitting in the write-ahead log, and prints a count that provably exceeds what `immutable=1` would see.

## Scope

**In scope:**

- Per-worktree setup: confirm `swift build` and `swift test` work, generate your fixture database, copy `.env.example` to `.env` with your track's values from `CONTRACTS.md` § 9.
- A `boi-cli` executable target with a `scan` subcommand.
- `MessageReader` opening `file:<path>?mode=ro` — a snapshot copy of the db plus its `-wal` and `-shm` sidecars is fine and is what the existing Python prototype does.
- Polling, with the interval configurable. 30s foregrounded, once per run otherwise.
- An assertion that `MAX(ROWID)` advances between runs, with an alarm if it does not.
- Excluding tapbacks (`associated_message_type` between 2000 and 3999) and group chats (`chat.style = 43`) from the 1:1 read.

**Explicitly out of scope for this prompt:**

- The local mirror — that is `02`.
- Decoding `attributedBody` — that is `03`. For now, a NULL-text row counts as a row with no text.
- Any metric computation.
- Any UI. There is no `.app` bundle until `07`.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** none consumed directly; you are producing raw rows. `CONTRACTS.md` § 10 explains the fixture database.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `python3 scripts/make_synthetic_chatdb.py --out /tmp/boi-a/chat.db` runs and reports `wal_only_rows: 1`
- [ ] `swift run --package-path mac boi-cli scan --db /tmp/boi-a/chat.db` prints a message count
- [ ] **The WAL check:** the count from your reader equals the count from `sqlite3 'file:/tmp/boi-a/chat.db?mode=ro'` and is exactly **one greater** than the count from the same file opened with `immutable=1`. Assert this in a test, not just by eye — it is the difference between a working product and one that silently stops seeing new messages.
- [ ] A test asserts the reader excludes tapbacks: the 1:1 message count is lower than `SELECT count(*) FROM message` by the tapback count
- [ ] A test asserts group-chat rows (`chat.style = 43`) are excluded from the 1:1 read
- [ ] Opening the database with `immutable=1` anywhere in `mac/` returns no matches: `grep -rn 'immutable' mac/` is empty
- [ ] The reader polls; `grep -rn 'FSEvents\|DispatchSource.*Vnode' mac/` returns no matches on the WAL or SHM paths
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

- the full output of `swift test --package-path mac`
- the printed counts for `mode=ro` versus `immutable=1`, side by side
- the `scan` command's stdout
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 01 reader — <what changed>"
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
