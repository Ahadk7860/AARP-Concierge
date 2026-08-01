# Track A — Prompt 03: Recover the 47% of messages that have no text column

**Depends on:** 01 (consumes the reader; same files)

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the reader from `01` exists. Independent of `02` — if the mirror work is
blocked, do this one instead.

Roughly **47% of real messages have `NULL text`**, with the body living in
`attributedBody` as an Apple typedstream: an undocumented pre-plist `NSArchiver` format.
Naive UTF-8 decoding corrupts it. Getting this wrong silently loses half the corpus and
reads as "the report is thin" rather than as a bug — which is why it gets its own prompt
and its own metric.

**The fixture database cannot help you here** and says so when it runs: synthesizing a
fake typedstream would let a broken decoder pass, which is worse than no fixture. So
this one is verified against your own `chat.db`, read-only, with a metric.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

Message text is recovered from `attributedBody` correctly enough that the share of messages with no recoverable text falls from roughly 47% to under 2% on a real corpus.

## Scope

**In scope:**

- A typedstream deserializer. **Do not write one from scratch if you can avoid it** — port `crabstep` (extracted from `imessage-exporter`), or call it. Say in `NOTES.md` which you chose and why.
- Wiring it into the reader so `text ?? decode(attributedBody)` is the single path everything else uses.
- A `boi-cli text-coverage --db <path>` command reporting: total messages, share with non-NULL `text`, share recovered from `attributedBody`, share still unrecoverable.
- Handling the encodings that actually appear: plain strings, attributed runs, and messages containing attachment placeholders (`U+FFFC`).

**Explicitly out of scope for this prompt:**

- Committing any real message data. Ever. Run against your own database read-only and commit only the aggregate numbers in your report.
- Attachment content. You are recovering text.
- Edits and unsends — the pre-edit original is available and interesting, but it is not this prompt.

## Constraints

- **Paths you may modify:** `mac/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** none consumed. `CONTRACTS.md` § 10, 'The one thing the fixtures cannot give you'.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `boi-cli text-coverage --db /tmp/boi-a/chat.db` runs against the fixture and reports the placeholder rows as unrecoverable, without crashing — the fixture's `attributedBody` values are deliberately not real typedstreams
- [ ] **The real metric, run against your own `~/Library/Messages/chat.db`, read-only:** unrecoverable share is **under 2%**, down from roughly 47%. Paste the before and after numbers. Do not paste any message text.
- [ ] A unit test decodes at least three real `attributedBody` blobs to their expected strings. Capture the blobs from your own database into a **gitignored** local fixture; commit the test, not the blobs. If you cannot commit a runnable test for this reason, say so explicitly in `NOTES.md` rather than deleting the test.
- [ ] Messages containing the attachment placeholder decode without raising, and the placeholder is stripped from the recovered text
- [ ] A malformed blob returns nil rather than throwing or returning garbage: a test feeds it random bytes
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

- `text-coverage` output on the fixture database
- `text-coverage` output on your own database — **numbers only, no message text**
- full `swift test` output
- the line in `NOTES.md` naming which deserializer you used and why
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add mac/
git commit -m "track-a: 03 typedstream — <what changed>"
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
