# Track D — Prompt 06: 8am local, and what happens when they reply '2'

**Depends on:** 05

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the composer from `05`.

Two halves. The scheduler decides *when*, per user timezone, skipping rather than sending
something wrong. The inbound handler decides what a reply *means* — and the reply that
matters most is `2`, meaning "I'll take the second draft."

Note what that reply does **not** do: it does not send anything. Boi hands the user the
text; the user sends it from their own Messages app. That line does not move.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

Briefs fire at roughly 8am in each user's local time, skip on staleness, and a numeric reply is attributed to the right brief item.

## Scope

**In scope:**

- Per-user timezone scheduling around 8am local.
- Skipping rather than sending when the digest is too stale, with the skip recorded.
- Idempotency: one brief per user per day, even if the scheduler runs twice.
- Inbound handling of `inbound.v1`: `1` and `2` attributed to the brief item via `reply_to_message_id`, falling back to the most recent brief when threading is unavailable.
- Responding to a selection by returning the chosen draft text for the user to copy or forward — **never by sending it to the third party.**
- Handling a reply that matches no brief, without guessing.

**Explicitly out of scope for this prompt:**

- Conversational agent behaviour. Per the architecture it is now optional and no longer the moat — Apple is about to give general assistant Q&A away for free.
- Auto-sending on the user's behalf. Not now, not behind a flag, not for a friendly beta user.
- Retry storms. One failed send is logged and retried on a schedule, not in a loop.

## Constraints

- **Paths you may modify:** `cloud/brief/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `inbound.v1`, `brief.v1`, `outbound.v1`, `Channel` — frozen. Fixtures: `contracts/fixtures/inbound/`.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] Three users in three timezones each get a brief within 15 minutes of 8am local — asserted with a controlled clock, not by sleeping
- [ ] **Idempotency:** running the scheduler twice for the same day produces one brief and one send per user
- [ ] A user whose digest exceeds the hard staleness threshold gets no send, and the skip is recorded with a reason — asserted
- [ ] **`contracts/fixtures/inbound/draft_choice_2.json` selects the second candidate of the correct item**, matched via `reply_to_message_id`
- [ ] With threading unavailable, a bare `2` attributes to the most recent brief for that user — asserted
- [ ] **The selection response contains the draft text and does not send anything to the third party:** `StubChannel.sent` contains exactly one message, addressed to the user
- [ ] A reply matching no brief produces a graceful response and no exception
- [ ] A failed send is retried on a schedule with a bounded attempt count — assert the bound, and assert no tight loop
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

- the three-timezone scheduling test output with the controlled clock
- the idempotency test
- the full exchange for the `2` reply: inbound document, response sent, and `StubChannel.sent` contents
- the staleness-skip record
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/brief/
git commit -m "track-d: 06 scheduler — <what changed>"
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
