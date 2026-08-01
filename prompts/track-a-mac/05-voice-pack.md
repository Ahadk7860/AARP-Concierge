# Track A — Prompt 05: Extract the voice pack, guarded three times

**Depends on:** 02, 03

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the mirror from `02` and the decoder from `03`. Independent of `04` — either can
run first.

This is the component where a bug is a privacy incident rather than a wrong number. The
voice pack carries the **user's own sent messages** — which is exactly why drafting does
not break the digest boundary: the voice we imitate is the user's, the content we must
understand is somebody else's, and those separate.

**Track B is writing the same extraction in Python**, deliberately. Theirs is the oracle
and the test, yours is what ships. At integration the two run on the same input and the
outputs are diffed. Write yours to match `CONTRACTS.md`, not to match a guess about
theirs.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

`boi-cli voice-pack` produces a `voice_pack.v1` per contact containing only redacted messages the user wrote, and the leak checker confirms it.

## Scope

**In scope:**

- Per-contact register statistics: median and p90 length, emoji rate and top emoji, punctuation style, greeting and signoff rates, abbreviations, average messages per burst, question rate, apology openers. **These are computed, not modelled** — plain SQL and string work.
- Up to **40 exemplars** per contact, each at most 200 characters. Beyond that the model gets no better and the blast radius gets worse.
- **`is_from_me = 1` enforced at the SQL layer**, and asserted again at the serializer. Two of the three guards live in this prompt.
- **Redaction before serialization:** phone numbers, email addresses, street addresses, dollar amounts, and third-party full names. The pack teaches cadence, not facts.
- A global fallback pack for new and thin contacts, `scope: "global"`, `contact_id: null`.
- `voice_pack_version` as a content hash, prefixed `vp_`. Changing it must invalidate the drafter's prompt cache, so it has to be deterministic over the pack contents.

**Explicitly out of scope for this prompt:**

- Drafting. You produce the pack; Track B consumes it.
- Uploading it. Disk only.
- Any exemplar selection that requires a model. Sample across the time range and across message lengths.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `voice_pack.v1` — `contracts/schema/voice_pack.v1.json`, frozen.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `boi-cli voice-pack --mirror /tmp/boi-a/mirror.db --out /tmp/boi-a/out/` writes one file per ranked contact plus `global_fallback.json`
- [ ] **`python3 scripts/validate_fixtures.py voice_pack.v1 <each file>` exits zero for every file**
- [ ] **`python3 scripts/check_voice_pack_leak.py --db /tmp/boi-a/chat.db --pack <each file>` exits zero for every file.** This is the third guard and it is a frozen anchor: do not weaken it, skip it, or narrow its input to make it pass.
- [ ] A test constructs a mirror where a distinctive inbound string exists, builds a pack, and asserts that string is **absent** from the exemplars. This test must fail if the `is_from_me` filter is removed — verify that by temporarily removing it, watching the test fail, and restoring it.
- [ ] A redaction test: exemplars built from messages containing a phone number, an email address, and a dollar amount contain none of the three
- [ ] No pack exceeds 40 exemplars or 200 characters per exemplar — asserted in a test
- [ ] `voice_pack_version` is deterministic: building the same pack twice yields the same version string; changing one exemplar changes it
- [ ] A contact with fewer than 5 sent messages produces no per-contact pack and falls back to global — asserted in a test
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

- validator output for every generated pack
- leak-checker output for every generated pack
- one generated pack in full — it contains only your own words, so this is safe to paste, but redact anything you would rather not share
- the test output showing the `is_from_me` test failing with the filter removed and passing with it restored
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 05 voice-pack — <what changed>"
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
