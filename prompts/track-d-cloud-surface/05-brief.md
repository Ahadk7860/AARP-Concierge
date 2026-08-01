# Track D — Prompt 05: Three items, two drafts each, and honest staleness

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the schema from `01`. Independent of `02`, `03` and `04` — it composes from
`contracts/fixtures/` and sends through `StubChannel`.

**Ranking is acquisition; the brief is retention.** The report gets them in the door
once. What keeps them is Boi texting every morning with the three people waiting on a
reply — each with two drafts already written.

Cap it at three. A list of twenty is noise; three is a habit.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A composer turns a digest, gists and draft bundles into a valid `brief.v1` of at most three items, and sends it through `Channel` with correct staleness behaviour.

## Scope

**In scope:**

- Composition from stored digest plus `draft_bundle.v1` documents.
- **Capped at three items**, ordered by priority.
- **Every item ships with a one-tap remedy.** Never a verdict without an action. Guilt without agency is repellent; guilt with a button is a product.
- Attaching the two drafts per item — and rendering an item **correctly when `drafts` is null**, which is the legitimate degraded case.
- **Staleness gating:** if the digest is older than `BOI_STALENESS_WARN_HOURS`, say so in the user's own terms — *"Haven't seen your Mac since Sunday, so this is as of then"* — rather than sending something wrong. Beyond a hard threshold, skip the send entirely.
- Rendering to `outbound.v1` blocks and sending through `Channel`. Use per-item threading when `capabilities()` reports it, and degrade silently when it does not.

**Explicitly out of scope for this prompt:**

- The scheduler — that is `06`.
- Generating gists or drafts. Track B does that; you consume fixtures.
- Sending anything on the user's behalf, to anyone but the user. **Ever.**
- Group chats.

## Constraints

- **Paths you may modify:** `cloud/brief/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `brief.v1`, `draft_bundle.v1`, `outbound.v1`, `Channel` — all frozen. Fixtures: `contracts/fixtures/brief/`, `contracts/fixtures/draft_bundle/`.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] Composing from `contracts/fixtures/digest/healthy.json` plus the draft-bundle fixtures yields a document passing `python3 scripts/validate_fixtures.py brief.v1 <output>`
- [ ] **Never more than three items**, asserted with an input containing ten candidates
- [ ] Every item has a non-null `remedy` — asserted
- [ ] **The degraded case:** an item whose `drafts` is `contracts/fixtures/draft_bundle/degraded_empty.json` renders sensibly with no drafts shown and no placeholder text implying drafts exist
- [ ] **Staleness:** a digest 98 hours old produces `staleness.warn = true` and a message naming the day, matching `contracts/fixtures/brief/stale_warning.json`'s shape; a digest 3 hours old produces `warn = false` and no message
- [ ] **The hard threshold skips the send**: beyond it, `StubChannel.sent` is empty and the reason is logged
- [ ] The composed `outbound.v1` passes `python3 scripts/validate_fixtures.py outbound.v1 <output>`
- [ ] Threading is used when `capabilities().threading` is true and **silently omitted** when false — both asserted
- [ ] `grep -rin 'reciproc' cloud/brief/` returns no matches
- [ ] Existing tests still pass: `npm test -- cloud/api cloud/brief cloud/card cloud/db` exits zero
- [ ] Lint passes: `npm run lint && npm run typecheck` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh d` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- the composed brief, in full
- the composed outbound message, in full, as text the user would receive
- the degraded-item render
- both staleness cases and the hard-threshold skip
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/brief/
git commit -m "track-d: 05 brief — <what changed>"
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
