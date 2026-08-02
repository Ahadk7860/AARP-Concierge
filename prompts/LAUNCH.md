# Launch runbook — Boi

Follow top to bottom. Everything is decided; nothing here needs a judgment call.

## Before you start

- [ ] The foundation commit is on `main`
- [ ] **You have pushed it:** `git push -u origin main`. This session could not push for
      you — the device bridge has no network. Push before cutting worktrees; a base that
      exists only locally produces worktrees you cannot share or recover.
- [ ] `git status --porcelain` in the main clone is empty
- [ ] You have 4 Claude Code sessions available, or are willing to run fewer in the order
      below

## Step 1 — Create the worktrees (one command)

From the **main clone** (`/Users/skylerluk/Dev/boi-imessage`), not from inside a worktree:

```bash
bash scripts/setup-worktrees.sh
```

It refuses to run from inside a worktree or on a dirty working tree, creates one worktree
per track, and prints the folder each session should open. Safe to re-run: existing
worktrees are skipped, and a branch whose directory was deleted by hand is reattached.

The manual equivalent is in `prompts/WORKTREE-PROTOCOL.md`. There is deliberately only one
hand-typed copy of those commands.

## Step 2 — Launch order

**All four tracks are independent — launch them all now.** The foundation commit already
contains every contract, stub and fixture, so nothing is waiting on anything.

**If you are running fewer sessions than tracks:** A, then B, then D, then C. A is the
critical path with the most prompts; B carries the most product risk; D is large but every
prompt is fixture-verifiable; C is last because its real verification is blocked on a Linq
token no matter when you build it.

## Step 3 — One session per track

Open a **separate Claude Code session per track.** Do not run two tracks in one session —
they will share context, and the isolation that makes this safe comes from the separation
as much as from the worktrees.

Each session must be opened **in that track's worktree folder**, not in the main clone.
Confirm with `pwd` before pasting anything.

---

### Track A — The Mac app

**Open a session in:** `/Users/skylerluk/Dev/boi-imessage-track-a`

Paste this as the first message:

```
You are the agent for Track A of this project.

Read these files before doing anything else:
  prompts/track-a-mac/TRACK.md          your standing brief
  prompts/CONTRACTS.md          the frozen shared surface
  prompts/MERGE-POLICY.md       read this before your first commit
  prompts/WORKTREE-PROTOCOL.md  commit and worktree rules

Then open prompts/track-a-mac/01-reader.md and execute only that prompt.

Rules that override anything you might otherwise assume:
- Work only inside this worktree. Never cd elsewhere, and never read or write another
  track's worktree.
- Touch only the paths TRACK.md says you own. Shared files are append-only, and the
  frozen files listed in CONTRACTS.md section 8 may not be changed at all.
- Run your own Definition of Done checklist and fix failures until it is green before
  reporting. Never weaken a test, assertion, lint rule, or type to make it pass.
- Commit when the prompt is complete, then STOP and report. Do not start the next
  prompt without my go-ahead.
- Do not merge, do not open a pull request, do not touch main.

Confirm you are in the right worktree with `pwd` and `git branch --show-current`
before you begin.
```

---

### Track B — Intelligence - the drafter

**Open a session in:** `/Users/skylerluk/Dev/boi-imessage-track-b`

Paste this as the first message:

```
You are the agent for Track B of this project.

Read these files before doing anything else:
  prompts/track-b-intelligence/TRACK.md          your standing brief
  prompts/CONTRACTS.md          the frozen shared surface
  prompts/MERGE-POLICY.md       read this before your first commit
  prompts/WORKTREE-PROTOCOL.md  commit and worktree rules

Then open prompts/track-b-intelligence/01-voice-pack.md and execute only that prompt.

Rules that override anything you might otherwise assume:
- Work only inside this worktree. Never cd elsewhere, and never read or write another
  track's worktree.
- Touch only the paths TRACK.md says you own. Shared files are append-only, and the
  frozen files listed in CONTRACTS.md section 8 may not be changed at all.
- Run your own Definition of Done checklist and fix failures until it is green before
  reporting. Never weaken a test, assertion, lint rule, or type to make it pass.
- Commit when the prompt is complete, then STOP and report. Do not start the next
  prompt without my go-ahead.
- Do not merge, do not open a pull request, do not touch main.

Confirm you are in the right worktree with `pwd` and `git branch --show-current`
before you begin.
```

---

### Track C — Transport - the channel spine

**Open a session in:** `/Users/skylerluk/Dev/boi-imessage-track-c`

Paste this as the first message:

```
You are the agent for Track C of this project.

Read these files before doing anything else:
  prompts/track-c-transport/TRACK.md          your standing brief
  prompts/CONTRACTS.md          the frozen shared surface
  prompts/MERGE-POLICY.md       read this before your first commit
  prompts/WORKTREE-PROTOCOL.md  commit and worktree rules

Then open prompts/track-c-transport/01-mock-linq.md and execute only that prompt.

Rules that override anything you might otherwise assume:
- Work only inside this worktree. Never cd elsewhere, and never read or write another
  track's worktree.
- Touch only the paths TRACK.md says you own. Shared files are append-only, and the
  frozen files listed in CONTRACTS.md section 8 may not be changed at all.
- Run your own Definition of Done checklist and fix failures until it is green before
  reporting. Never weaken a test, assertion, lint rule, or type to make it pass.
- Commit when the prompt is complete, then STOP and report. Do not start the next
  prompt without my go-ahead.
- Do not merge, do not open a pull request, do not touch main.

Confirm you are in the right worktree with `pwd` and `git branch --show-current`
before you begin.
```

---

### Track D — Cloud - the product surface

**Open a session in:** `/Users/skylerluk/Dev/boi-imessage-track-d`

Paste this as the first message:

```
You are the agent for Track D of this project.

Read these files before doing anything else:
  prompts/track-d-cloud-surface/TRACK.md          your standing brief
  prompts/CONTRACTS.md          the frozen shared surface
  prompts/MERGE-POLICY.md       read this before your first commit
  prompts/WORKTREE-PROTOCOL.md  commit and worktree rules

Then open prompts/track-d-cloud-surface/01-schema.md and execute only that prompt.

Rules that override anything you might otherwise assume:
- Work only inside this worktree. Never cd elsewhere, and never read or write another
  track's worktree.
- Touch only the paths TRACK.md says you own. Shared files are append-only, and the
  frozen files listed in CONTRACTS.md section 8 may not be changed at all.
- Run your own Definition of Done checklist and fix failures until it is green before
  reporting. Never weaken a test, assertion, lint rule, or type to make it pass.
- Commit when the prompt is complete, then STOP and report. Do not start the next
  prompt without my go-ahead.
- Do not merge, do not open a pull request, do not touch main.

Confirm you are in the right worktree with `pwd` and `git branch --show-current`
before you begin.
```

---

## Step 4 — Between prompts, and how much to batch

### The gate

After **every** prompt, batched or not, the track runs:

```bash
bash scripts/gate.sh <letter>
```

Typecheck, tests, lint, fixture validation, ownership, and a check that no test suite
silently skipped. Non-zero on any failure. **A track running a batch stops at the first
red gate** — it does not continue, and it does not "fix it in the next prompt."

The gate runs typecheck *first*, deliberately. A suite that cannot compile reports zero
failures, which reads identically to a suite that passed. That is not hypothetical: one
track shipped a prompt whose test file imported two symbols its own mock did not export.
Twenty-nine tests skipped, `typecheck` was reported green, and the checklist came back
clean. No human reading the report could have caught it. The gate can.

### How much to batch

Batch **prompts with no dependency edge between them.** Stop at any prompt whose output
everything downstream consumes. The reasoning is about blast radius, not speed: a wrong
assumption inside a batch of independent prompts stays contained, while the same
assumption made in a prompt others build on compounds into every prompt after it.

| Track | Batch | Check in after |
|---|---|---|
| A | `01` alone · then `02`+`03` · then `04`+`05` · then `06` · then `07` | 5 stops, not 7 |
| B | `01` alone · then `02`+`03`+`04` · then `05` | 3 stops, not 5 |
| C | `01` alone · then `02`+`03` · then `04` | 3 stops, not 4 |
| D | `01` alone · then `02`+`03`+`04`+`05` · then `06` | 3 stops, not 6 |

Prompt `01` is never batched in any track. It establishes the environment and the
foundational abstraction the rest of the track builds on, so an error there is the one
that compounds furthest.

Within a batch: **one commit per prompt, and one gate run per prompt.** Batching changes
how often *you* look, not how often the track verifies itself. A batch delivered as one
commit has thrown away the per-prompt audit trail and should be sent back.

### To start a batch

```
Run prompts 02 and 03. After each one: commit, then run `bash scripts/gate.sh <letter>`
and paste the output. If the gate is red, stop there and report — do not start the next
prompt. Report both prompts together when the batch is done.
```

### When a track reports

1. Read the **gate output**, not the prose summary. A green checklist with no pasted
   command output is not evidence.
2. If it looks right, send the next batch.
3. If something is off, say what and let it fix it in the same session — that session
   holds the context.
4. Update the status table in `prompts/README.md`.

**If a track is blocked:** check its `NOTES.md`. If the blocker is a contract gap, it
affects every track consuming that contract — follow the contract-amendment procedure in
`prompts/WORKTREE-PROTOCOL.md` before letting anyone continue.

**Reordering within a track:** read the `Depends on` column in `TRACK.md`, not the
numbering. If `02` is blocked and `03` depends only on `01`, run `03`.

## Step 5 — When a track finishes

The working session does **not** review itself, and the review is not one reader. Three
passes, three different readers, because the three questions worth asking need opposite
things: one needs a machine that can execute the suite, one needs maximum ignorance, one
needs maximum context. Full procedure: `prompts/TRACK-REVIEW.md`.

### 5a — Evidence (you, in the worktree, 30 seconds)

```bash
cd /Users/skylerluk/Dev/boi-imessage-track-<letter>
bash scripts/review-capture.sh <letter>
```

Re-runs that track's tests, lint, ownership check and fixture validation from a clean
state and writes `review-capture-<letter>.md` in the worktree. A failing command is the
finding — do not fix it and re-run.

This step lives on your Mac because it has to: the planning session runs in a Linux
container with no Swift, no Xcode and no local Postgres, so it cannot execute Track A's
suite or Track D's migrations. Execution happens where it can; only the output travels.

### 5b and 5c — Hand it to the planning session

Say **"Track \<letter\> is done"** in the planning conversation and attach
`review-capture-<letter>.md`. It runs the remaining two passes:

- **Pass 2, diff audit** — a fresh subagent it spawns, with no memory of the plan and no
  access to the conversation, told to try to fail the track on five questions plus one
  only it can ask: *was the criterion worth satisfying?* The planning session wrote every
  Definition of Done before any code existed, so it cannot judge its own criteria — a
  badly specified check looks correct to whoever specified it. That is why this pass has
  no memory, and it is the reason the review is not collapsed into one seat.
- **Pass 3, alignment** — the planning session itself. The question no track can ask
  about itself: does this contradict another track, is the contract still right, does it
  hold the product line, and what did this track learn that changes the plan. It may make
  surgical edits to `prompts/` and `contracts/` through the amendment procedure in
  `WORKTREE-PROTOCOL.md`. It does not edit track code and it does not merge.

You get back a merge recommendation and a list of what changed in the plan.

### 5d — You merge

Nothing merges on its own and no pass may skip a step. If Pass 3 amended a contract,
forward-merge it into every affected track **before** anyone resumes:

```bash
git merge main    # inside each affected worktree. Never rebase.
```

## Step 6 — What is deliberately not in this round

Do not create a fifth track for any of these. Each fails the verifiability test: none can
reach a green Definition of Done against the foundation stubs, because each needs another
track's real code to exist first.

- **Notarization, Developer ID signing, Sparkle auto-update.** Needs a paid Apple
  Developer account and a finished app. This is the round after.
- **End-to-end integration** — a real person completing the whole flow.
- **The real Linq token**, and the six sales-call questions in `CONTRACTS.md` § 11.
- **Group chats.** Technically unblocked — Linq creates and manages threads
  programmatically — but deferred on consent grounds, which is a design problem rather
  than an API problem.
- **Gmail / Calendar OAuth.** Gmail is a restricted scope: CASA audit, $540–$4,500/yr,
  several weeks. Start the paperwork now; ship without it.

## Quick reference

| Track | Worktree | Branch | Prompts | Ports | Session |
|---|---|---|---|---|---|
| A | `/Users/skylerluk/Dev/boi-imessage-track-a` | `track-a-mac` | 7 | 3010-3019 | 1 |
| B | `/Users/skylerluk/Dev/boi-imessage-track-b` | `track-b-intelligence` | 5 | 3020-3029 | 2 |
| C | `/Users/skylerluk/Dev/boi-imessage-track-c` | `track-c-transport` | 4 | 3030-3039 | 3 |
| D | `/Users/skylerluk/Dev/boi-imessage-track-d` | `track-d-cloud-surface` | 6 | 3040-3049 | 4 |
