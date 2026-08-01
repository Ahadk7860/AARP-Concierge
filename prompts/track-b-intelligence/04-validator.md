# Track B — Prompt 04: The validator, which is not a model

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the environment from `01`. Independent of `02` and `03` — it operates on
`draft_bundle.v1` and `gist.v1` objects, and `contracts/fixtures/` has both, including
two model transcripts recorded specifically to violate these gates
(`fabrication_violation.json` and `assistant_speak_violation.json`).

Rules, deterministic, no model. The reason it is not a model is that its job is to be
**boringly reliable at refusing**, and a model asked to judge its own family's output
grades gently.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A validator refuses drafts that are too long, off-register, fabricated, or written in assistant-speak, and degrades to zero candidates rather than shipping a bad one.

## Scope

**In scope:**

- **Length gate** — within 2× the user's median message length for that contact. A 300-character paragraph from someone who writes 34 characters is the tell.
- **Register gate** — no capitalized first letter if the user does not capitalize, no terminal period if they do not use one, no emoji if their rate is under 2%. These are what people notice instantly.
- **Fabrication gate** — reject any draft containing a date, time, place, amount or name that is not present in `gist.facts`. **The highest-severity failure mode:** a plausible, wrong commitment sent to a friend in the user's own name.
- **Forbidden-phrase list** — start from `FORBIDDEN_PHRASES` in the frozen contracts and extend it. Assistant-speak in a text to your roommate is worse than no draft at all.
- **Stance-collision check** — two candidates with the same stance is a fake choice.
- **Retry once, then degrade.** If both candidates fail, retry with the failures named in the prompt. If it fails twice, return a bundle with **zero** candidates and the failures recorded.

**Explicitly out of scope for this prompt:**

- Using a model to judge drafts.
- Rewriting a failing draft yourself. You refuse; the drafter retries.
- Softening a gate because a real draft tripped it. If a gate is wrong, that is a finding for `NOTES.md`, not an edit.

## Constraints

- **Paths you may modify:** `intelligence/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `draft_bundle.v1.validator` — the `failures` enum is frozen. `gist.v1.facts` is the fabrication allowlist. `FORBIDDEN_PHRASES` is in the frozen `contracts.py`; extend, never shorten.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] **`contracts/transcripts/model/fabrication_violation.json` is rejected with `fabrication_gate`.** Its draft says 'yes im free thursday at 7' against a gist whose `facts` contain no Thursday and no 7 — this transcript exists to prove the gate bites.
- [ ] **`contracts/transcripts/model/assistant_speak_violation.json` is rejected with `forbidden_phrase`.**
- [ ] `contracts/fixtures/draft_bundle/maya_pass.json` passes every gate
- [ ] Length gate: a draft at 2.1× the register median is rejected; one at 1.9× passes — both asserted
- [ ] Register gate: given a `lowercase_no_period` register, a draft starting with a capital is rejected, and one with a terminal period is rejected
- [ ] Fabrication gate accepts a specific that IS in `facts`: a draft naming 'the 14th' against the Maya gist passes
- [ ] Stance collision is caught: two `answer` candidates are rejected with `stance_collision`
- [ ] **Degradation:** after two failed attempts the result is a bundle with zero candidates, `validator.passed = false`, `attempts = 2`, and the failure list populated. A test asserts it returns rather than raising, and that the bundle validates against the schema.
- [ ] Every value in `validator.failures` is one of the frozen enum values — asserted
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

- the rejection output for both violation transcripts, with the failure reasons
- the pass output for `maya_pass.json`
- the degraded zero-candidate bundle, in full
- the extended forbidden-phrase list, and the `NOTES.md` line saying what you added and why
- full `pytest` output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add intelligence/
git commit -m "track-b: 04 validator — <what changed>"
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
