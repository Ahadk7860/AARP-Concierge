# Track C — Prompt 04: Line assignment, and the day the line is banned

**Depends on:** 02

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the adapter from `02`.

A user's line changing is a **retention event dressed up as an infrastructure event**:
their conversation history is gone and Boi arrives as an unknown sender. And one banned
line takes out every user assigned to it simultaneously.

Everything here is built against mock states, because the real behaviour is four open
sales-call questions (`CONTRACTS.md` § 11 items 4–7). **The point of this prompt is that
when those answers arrive they land in config.**

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

Every user has a sticky line assignment, line health is tracked and observable, and an unhealthy line degrades the send in the same turn rather than failing it.

## Scope

**In scope:**

- A `line → user` mapping, explicit and queryable. **You must be able to answer 'who just lost their thread?' in one query.**
- **Sticky assignment.** A user keeps their line. Rotation is a first-class migration event, not an infrastructure detail.
- Health polling with `up` / `degraded` / `banned`, emitting `line.health_changed` when it moves.
- **Automatic downgrade:** line unhealthy → the same message goes out over the fallback in the same turn. Green and late beats blue and never.
- Rotation handling: on arrival from a new line, lead with an explicit 'this is Boi, new number' rather than resuming mid-conversation. Conversation state stays server-side keyed to `user_id`, so nothing is actually lost but the bubbles.
- Configurable users-per-line, defaulting low. Cost is linear in lines; ban risk is super-linear in users per line.
- A metric surface: users affected per line, so a ban's blast radius is visible immediately.

**Explicitly out of scope for this prompt:**

- Twilio as the fallback target. Stub the fallback behind an interface; Linq's own RCS/SMS fallback covers per-message degradation, and the Twilio adapter is a later-round business-continuity concern.
- Deciding the real users-per-line number. That depends on unanswered sales questions.
- Persisting line state to Postgres. Track D owns the database; in-process plus a documented interface is correct for this round.

## Constraints

- **Paths you may modify:** `cloud/channel/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `ChannelHealth` — frozen. `line.health_changed` payload — `CONTRACTS.md` § 4.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] A user assigned a line keeps it across 100 consecutive sends — asserted
- [ ] **The blast-radius query:** given a `line_id`, one call returns every affected `user_id`. Asserted with three users on one line.
- [ ] Health transitions emit `line.health_changed` exactly once per transition, not once per poll — asserted with a poll loop
- [ ] **Automatic downgrade:** with `MOCK_LINQ_MODE=banned`, a send still succeeds via the fallback in the same call, and the result records which path it took
- [ ] Rotation produces the 'this is Boi, new number' preamble on the first message from the new line, and only the first — asserted
- [ ] Users-per-line is configurable and enforced: setting it to 2 and assigning a third user allocates a second line
- [ ] Every unanswered question in `CONTRACTS.md` § 11 items 3–7 corresponds to a **named config value**, not a hard-coded constant. List them in your report.
- [ ] The metric surface reports users-per-line and current health for every line
- [ ] Existing tests still pass: `npm test -- cloud/channel cloud/mock-linq` exits zero
- [ ] Lint passes: `npm run lint && npm run typecheck` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh c` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- the blast-radius query output for three users on one line
- the downgrade test output showing the path taken
- the rotation preamble test
- the list of config values that stand in for the open sales-call questions
- full test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/channel/
git commit -m "track-c: 04 line-health — <what changed>"
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
