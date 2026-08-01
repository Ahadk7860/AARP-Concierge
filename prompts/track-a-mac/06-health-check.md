# Track A — Prompt 06: The health check, before the pairing code

**Depends on:** 04

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the digest from `04`.

**This is the most important screen in the app and it does not exist in any earlier
doc.** A user grants access, the scan runs, and finds 400 messages instead of 84,000.
They have just done the hardest thing we will ever ask of them and they get a thin,
boring report. They do not conclude "my sync is off" — they conclude the product is bad.

Estimated to affect **15–30% of first-cohort users.** It deserves a first-class screen,
not an error state. This prompt builds the logic; `07` builds the screen.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A health check between the scan and the pairing code classifies the corpus as healthy, fixable, or thin, and names the specific setting to change when it is fixable.

## Scope

**In scope:**

- Compute: total messages, distinct threads, date span, days since the newest message.
- **The exact-boundary signature** — a span landing on precisely 365 or 30 days means Apple's *Keep Messages* setting is trimming, not that the person is new. Four top-25 conversations starting at exactly the boundary is truncation, not coincidence.
- Messages-in-iCloud state, read programmatically.
- Green-bubble share versus what Contacts implies it should be. SMS reaches the Mac only via Text Message Forwarding, which has **no server-side queue** — if the Mac was asleep those messages may never arrive at all.
- Branch to one of three outcomes and set `corpus.health` and `corpus.health_reasons` in the digest accordingly.
- For `fixable`: name the setting, produce the `x-apple.systempreferences:` deep link, and support a re-scan.
- For `thin`: say so honestly, and offer to text the report in a week once history accumulates. **Never hand someone a bad report and call it their year in messages.**

**Explicitly out of scope for this prompt:**

- The SwiftUI screen — that is `07`. This prompt produces the decision and the copy; `07` renders it.
- Actually changing any system setting. You deep-link and re-scan; the human clicks.
- Uploading the health result.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `digest.v1` `corpus.health` and `corpus.health_reasons` — frozen enum values in `contracts/schema/digest.v1.json`.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `boi-cli health --mirror <path>` prints the classification, the reasons, and the remedy copy
- [ ] **Three fixture cases classify correctly**, asserted in tests: a 365-day-exact span → `fixable` with reason `keep_messages_1y`; a 24-day span with 412 messages → `thin`; the full fixture → `healthy` or `fixable` with the reason stated
- [ ] The generated digest's `corpus.health` matches the CLI's classification — a test asserts they cannot diverge
- [ ] `python3 scripts/validate_fixtures.py digest.v1 /tmp/boi-a/out/digest.json` still exits zero with health fields populated
- [ ] The deep link string is present and matches `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` for the FDA case, with a plain-text fallback string also present
- [ ] A test asserts the `thin` path produces the honest copy and **does not** produce a report
- [ ] Boundary detection is tested at the edges: 364, 365, and 366 days classify as not-boundary, boundary, not-boundary
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

- `boi-cli health` output for all three fixture cases
- the remedy copy for the `fixable` case, verbatim
- full `swift test` output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 06 health-check — <what changed>"
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
