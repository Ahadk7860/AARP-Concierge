# Track A — Prompt 04: The metric library, and a digest that validates

**Depends on:** 02, 03

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the mirror from `02` and the decoder from `03`. Independent of `05` — either can
run first.

Everything here is **plain SQL over the mirror**. No model, no network, no cost. The
whole library is a set of aggregate queries, and on 84,000 messages it completes in
under two seconds — which is why there is no upload, no progress bar, and no drop-off
window in the funnel.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

`boi-cli digest` writes a `digest.v1` document that passes the schema validator, computed from the local mirror.

## Scope

**In scope:**

- **Momentum** — 90-day trend (recent quarter over prior quarter), days since last contact, longest gap, streaks. This is where the signal is: 0.0× to 13.9× across 25 real relationships.
- **Effort asymmetry** — initiation ratio, who sends the last message before a thread dies, unanswered-question count.
- **Timing** — median and p90 reply latency per direction, latency asymmetry.
- **Warmth** — tapbacks given versus received, `was_delivered_quietly` (whether they have you muted).
- **Context** — call count and minutes from `CallHistoryDB`, blue versus green share.
- **Whole-life** — total volume, unique people, concentration in the top 1/5/10, relationships gone quiet.
- **Contact resolution merging on the AddressBook record ID, not the handle string.** The existing Python prototype merges on handle and splits one person into two entries, corrupting the top of the ranking. Do not reproduce that bug.
- Archetype classification: `fade`, `chapter`, `one_way_enthusiasm`, `the_one_you_keep_waiting`, `rising_fastest`.
- `contact_id = HMAC(user_salt, normalized_handle)`, hex, prefixed `h_`. Use a fixed dev salt from `.env`; the real one arrives from `POST /v1/pair`.

**Explicitly out of scope for this prompt:**

- **Reciprocity, in any form.** Across 25 real relationships the spread was 0.465–0.615, sd 0.034 — it carries almost no information, and it is the most legally dangerous metric in the category. Do not compute it, do not put it in the digest, do not add it 'just in case'.
- Any numeric score attached to a human being.
- Uploading anything. The digest goes to disk.
- The voice pack — that is `05`.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `digest.v1` — `contracts/schema/digest.v1.json`, and the Swift mirror in `mac/Sources/BoiKit/Contracts.swift`, both frozen.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `boi-cli digest --mirror /tmp/boi-a/mirror.db --out /tmp/boi-a/out/digest.json` writes a file
- [ ] **`python3 scripts/validate_fixtures.py digest.v1 /tmp/boi-a/out/digest.json` exits zero.** This is the cross-language check and it is the real bar.
- [ ] The digest decodes into the frozen `Digest` struct and re-encodes without loss: a test round-trips it
- [ ] **The contact-merge test:** a fixture where one person appears under two handles (a phone number and an email) produces exactly **one** relationship row, not two
- [ ] Archetypes are assigned: on the fixture database at least one relationship classifies as `fade` and the assignment is asserted in a test with the threshold stated
- [ ] `grep -rin 'reciproc' mac/` returns no matches
- [ ] **Timing:** the digest completes in under 5 seconds over the fixture mirror; print the elapsed time
- [ ] Every relationship row carries an `as_of` — a test asserts none is empty or defaulted
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

- the validator output for your generated digest
- the digest's top five relationships, **display names replaced with `Person 1..5`**, showing momentum and initiation ratio
- elapsed time for the digest run
- full `swift test` output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 04 metrics-digest — <what changed>"
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
