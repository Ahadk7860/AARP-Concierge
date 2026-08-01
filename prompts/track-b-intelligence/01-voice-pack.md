# Track B — Prompt 01: The voice-pack builder, and the oracle for Track A

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
the frozen `intelligence/boi_intel/contracts.py`, the frozen `FakeProvider`, one passing
test suite, and the fixtures under `contracts/`. Worktrees share neither untracked files
nor installed dependencies, so per-worktree setup happens here.

What comes after: `02`, `03` and `04` all depend only on this prompt and are mutually
independent — the foundation fixtures decouple them. Do not start them yet.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A CLI builds a `voice_pack.v1` per contact from a `chat.db`, containing only redacted messages the user wrote, and the leak checker confirms it.

## Scope

**In scope:**

- Per-worktree setup: virtualenv, `pip install -e '.[dev]'`, `.env` from `.env.example` with your track's values, and generate your fixture database.
- `python -m boi_intel.voice --db <path> --out <dir>` producing one pack per contact plus a global fallback.
- Register statistics — median and p90 length, emoji rate, punctuation style, greeting and signoff rates, abbreviations, messages per burst, question rate, apology openers. **Computed, not modelled.**
- Up to 40 exemplars per contact, 200 characters each, sampled across the time range and across lengths.
- **`is_from_me = 1` at the SQL layer and asserted again at the serializer.**
- Redaction: phone numbers, emails, street addresses, dollar amounts, third-party full names.
- `voice_pack_version` as a deterministic content hash, prefixed `vp_`.
- A `--compare <other.json>` mode that diffs two packs field by field. **This is what Track A's Swift port is verified against at integration** — build it now, while the semantics are fresh.

**Explicitly out of scope for this prompt:**

- Drafting, gists, or anything touching a model.
- Uploading anything.
- Selecting exemplars with a model. Sampling is sufficient and free.

## Constraints

- **Paths you may modify:** `intelligence/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `voice_pack.v1` — `contracts/schema/voice_pack.v1.json`, frozen.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `python -m boi_intel.voice --db /tmp/boi-b/chat.db --out /tmp/boi-b/out/` writes one file per contact plus `global_fallback.json`
- [ ] **`python3 scripts/validate_fixtures.py voice_pack.v1 <each file>` exits zero for every file**
- [ ] **`python3 scripts/check_voice_pack_leak.py --db /tmp/boi-b/chat.db --pack <each file>` exits zero for every file.** Frozen anchor — do not weaken, skip, or narrow its input to make it pass.
- [ ] A test constructs a database containing a distinctive inbound string, builds a pack, and asserts the string is absent. **Verify the test actually bites:** temporarily remove the `is_from_me` filter, watch it fail, restore it, and paste both runs.
- [ ] A redaction test: exemplars built from messages containing a phone number, an email, and a dollar amount contain none of the three
- [ ] No pack exceeds 40 exemplars or 200 characters per exemplar — asserted
- [ ] Determinism: building twice yields identical `voice_pack_version`; changing one exemplar changes it
- [ ] A contact with fewer than 5 sent messages yields no per-contact pack and falls back to global
- [ ] `--compare` reports zero differences between a pack and itself, and reports the specific field when one value is edited
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

- validator and leak-checker output for every generated pack
- the two test runs showing the leak test failing without the filter and passing with it
- one generated pack in full
- `--compare` output for the identical and the edited case
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add intelligence/
git commit -m "track-b: 01 voice-pack — <what changed>"
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
