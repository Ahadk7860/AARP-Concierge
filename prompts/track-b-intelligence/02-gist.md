# Track B — Prompt 02: Gists: SQL first, model second

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the environment from `01`. Independent of `03` and `04` — any of the three can
run next.

The gist is what lets the cloud learn *what you owe someone* without learning *what they
said*. It reads the other person's text, so it runs on the Mac. Its `facts` object is
the fabrication-gate allowlist the validator in `04` checks against — get that shape
right and `04` becomes easy.

**Build the SQL-only path first.** It ships as the permanent fallback for Intel Macs,
low disk, and failed downloads, and it de-risks the whole workstream: if the local model
never lands, the product still works and the drafts are merely vaguer.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A gist producer emits a valid `gist.v1` for a thread, with a SQL-only implementation and a local-model implementation behind one interface.

## Scope

**In scope:**

- SQL triage: who is waiting, how long, is there an unanswered question, is there a date-like token. Zero model, zero download, works everywhere.
- `GistProducer` protocol with `SqlGistProducer` and `LocalModelGistProducer` behind it.
- The local model path: 3–4B class via MLX with a llama.cpp CPU fallback, ~2GB quantized, **downloaded after the report is delivered, never blocking onboarding**. If the model cannot be obtained in this environment, implement the interface and the download logic, mark it in `NOTES.md`, and verify the SQL path — do not fake model output.
- **Populating `facts` correctly.** Every date, time, place, amount and name the drafter is allowed to mention, and nothing else. Under-populating makes drafts vague; over-populating defeats the fabrication gate.
- The `gist` string: at most 140 characters, second person, describing what the user owes. **Never a quotation.**
- Priority scoring so the brief can take the top three.

**Explicitly out of scope for this prompt:**

- Drafting — that is `03`.
- Any gist that contains verbatim text from the other person. A test must enforce this.
- Shipping the model download in an installer. You implement it; Track A packages it later.

## Constraints

- **Paths you may modify:** `intelligence/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `gist.v1` — `contracts/schema/gist.v1.json`, frozen. Note `facts` is an allowlist, not decoration.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `python -m boi_intel.gist --db /tmp/boi-b/chat.db --top 5 --out /tmp/boi-b/out/gists/` writes files
- [ ] **`python3 scripts/validate_fixtures.py gist.v1 <each file>` exits zero**
- [ ] `producer` is `sql` when `BOI_LOCAL_GIST_MODEL` is empty, and the whole path runs with no model present — asserted in a test
- [ ] **The no-verbatim test:** a test seeds a thread with a distinctive inbound sentence and asserts that sentence does not appear in the gist string. This is the property that keeps the digest boundary intact.
- [ ] `facts` extraction is tested at both edges: a thread mentioning 'the 14th' and 'Friday' yields both in `facts.dates`; a thread mentioning no specifics yields five empty lists
- [ ] Every gist string is 140 characters or fewer — asserted over all generated output
- [ ] Priority ordering is stable and tested: the same input yields the same ranking
- [ ] If the local model is unavailable, the producer degrades to SQL and records it, rather than raising — asserted in a test
- [ ] Existing tests still pass: `python -m pytest` exits zero
- [ ] Lint passes: `ruff check intelligence` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh b` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- validator output for every generated gist
- three generated gists in full, with `display` replaced by `Person 1..3`
- the no-verbatim test output
- the `NOTES.md` line recording the local model's status in your environment
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add intelligence/
git commit -m "track-b: 02 gist — <what changed>"
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
