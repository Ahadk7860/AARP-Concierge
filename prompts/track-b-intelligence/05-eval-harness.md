# Track B — Prompt 05: Ground truth is free — use it to pick the model

**Depends on:** 03, 04

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the drafter from `03` and the validator from `04`.

This is unusual and it is the most valuable prompt in the track: **for any thread where
the user did eventually reply, we already have the message they actually sent.** So the
eval set builds itself. Reconstruct the state at time T, draft, and compare to what they
really wrote. No labelling, no human raters, and it is the user's genuine voice rather
than a rater's opinion of it.

It re-runs for free on every prompt change, and it runs entirely locally against a
`chat.db`.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

An eval harness scores drafts against what the user actually sent, and produces a model comparison table that settles Gemini Flash-Lite versus Kimi K2.5 on register fidelity rather than on price.

## Scope

**In scope:**

- Reconstruct thread state at time T for every thread where the user later replied. Build the voice pack from messages **before** T only — leaking the future is the easiest way to get a fake-good score.
- Metrics: register-match rate, length delta versus the real reply, validator pass rate, cost per draft, latency.
- `--models gemini-2.5-flash-lite,kimi-k2.5,fake` producing one comparison table.
- A held-out set of 50 pairs for human preference, exported as a simple review file.
- **The send-rate question**, prepared but not answered by you: export 20 draft pairs in a format a human can mark `send` / `edit` / `delete`. This is the drafting analogue of the report-card kill test, and it is the thing that decides whether the feature ships.

**Explicitly out of scope for this prompt:**

- Deciding the model yourself. Produce the table and a recommendation; the user decides.
- Fine-tuning anything.
- Any change to the gates in `04` to improve a score. That is scoring your own exam.

## Constraints

- **Paths you may modify:** `intelligence/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** all of them; the harness exercises the full path.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `python -m boi_intel.eval --db /tmp/boi-b/chat.db --models fake --n 20` runs end to end with no network and prints a table
- [ ] **No future leakage:** a test asserts the voice pack used for a draft at time T contains no message dated at or after T. This is the correctness property the whole harness rests on.
- [ ] The table reports register-match rate, median length delta, validator pass rate, cost per draft, and p50 latency, per model
- [ ] A live run with `--models gemini-2.5-flash-lite` and `BOI_ALLOW_LIVE_CALLS=1` completes over at least 20 threads and reports actual measured cost
- [ ] Kimi is attempted and, if its key is unprovisioned, reported as skipped with the reason — **not silently omitted from the table**
- [ ] The 20-pair review file is written and is readable by a human with no tooling
- [ ] Re-running the harness on the same input with `fake` produces identical numbers — determinism asserted
- [ ] The harness caps its own spend: a `--max-calls` limit is enforced and tested
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

- the full comparison table
- the measured cost per user per month, extrapolated, with your assumptions stated
- the no-future-leakage test output
- five draft pairs from the review file, with contact names replaced
- your recommendation, in two sentences, and what would change it
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add intelligence/
git commit -m "track-b: 05 eval-harness — <what changed>"
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
