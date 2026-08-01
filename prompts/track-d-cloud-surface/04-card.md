# Track D — Prompt 04: The 9:16 card, which is the entire acquisition loop

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the environment from `01`. Independent of `02`, `03` and `05` — it takes a
digest fixture and produces an image.

The card gets screenshotted into a group chat, and every share arrives with social proof
attached. It renders **server-side** so it is identical for everyone and does not depend
on a client.

The hook is **the fade, not the ranking.** Every competitor ranks friends by volume and
none have gone viral, because volume tells people something they already know. *"Yu used
to reply to you in 16 seconds. You've sent 10 messages in 90 days"* is information the
user cannot get anywhere else and immediately feels something about.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A renderer turns a `digest.v1` into a 9:16 PNG carrying one judgmental number and the named archetypes, identically for every user.

## Scope

**In scope:**

- Deterministic server-side render to PNG at 1080×1920.
- **One judgmental number** — e.g. *40% of your 25 closest friendships went quiet this year.* Specific, slightly damning, instantly quotable.
- **The archetype taxonomy** — the fade, the chapter, one-way enthusiasm, the one you keep waiting, rising fastest. Named archetypes are what people post, because posting them says something about who they are.
- **Invitation, never verdict**, in every line of copy. Never *"Sarah doesn't text you back"*; always *"you've reached out to Sarah 12 times this month."* Snapchat built friend-ranking twice and suppressed it both times.
- Graceful handling of a `thin` digest: render something honest, or render nothing and say why. **Never hand someone a bad report and call it their year in messages.**
- Name truncation and overflow that does not break the layout.

**Explicitly out of scope for this prompt:**

- Reciprocity, in any form, anywhere on the card.
- Any numeric score attached to a human being.
- Client-side rendering.
- Final visual design. Get the content and the constraints right; a designer improves it later. Design quality and shareability are different variables.

## Constraints

- **Paths you may modify:** `cloud/card/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `digest.v1` — frozen. Fixtures: `healthy.json`, `thin.json`, `fixable_keep_messages_30d.json`.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `POST /render` on port **3042** with `contracts/fixtures/digest/healthy.json` returns a PNG that is exactly 1080×1920 — assert the dimensions programmatically
- [ ] **Determinism:** rendering the same digest twice produces byte-identical output
- [ ] The card names at least two archetypes present in the digest, and the judgmental number matches a value computable from the digest — asserted, not eyeballed
- [ ] **The `thin` fixture does not produce a normal card.** It produces either the honest alternative or a documented refusal. Asserted.
- [ ] `grep -rin 'reciproc' cloud/card/` returns no matches
- [ ] **Copy review:** every string on the card is listed in your report, and none of them is a verdict about another person. This one is judgment, not a script — do it honestly.
- [ ] A 40-character display name and a 1-character name both render without breaking the layout — attach both images
- [ ] Render completes in under 2 seconds for the healthy fixture
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

- the rendered PNG for `healthy.json`
- the rendered PNG or refusal for `thin.json`
- both name-overflow renders
- **every string on the card, listed**, with your own assessment of the invitation-not-verdict rule
- the determinism test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/card/
git commit -m "track-d: 04 card — <what changed>"
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
