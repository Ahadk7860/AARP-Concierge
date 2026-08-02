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

## Step 4 — Between prompts

When a track reports a completed prompt:

1. Skim the Definition of Done checklist and the evidence it pasted. **Evidence, not
   assertions** — if it claims a test passes without pasting the output, ask for the
   output.
2. If it looks right, reply with the next prompt:
   `Open prompts/track-<x>-<slug>/02-<slug>.md and execute only that prompt.`
3. If something is off, say what and let it fix it in the same session — that session
   holds the context.
4. Update the status table in `prompts/README.md`.

**If a track is blocked:** check its `NOTES.md`. If the blocker is a contract gap, it
affects every track consuming that contract — follow the contract-amendment procedure in
`prompts/WORKTREE-PROTOCOL.md` before letting anyone continue.

**Reordering within a track:** read the `Depends on` column in `TRACK.md`, not the
numbering. The real reorder opportunities in this plan:

| Track | Independent of each other | What it buys |
|---|---|---|
| A | `02` and `03`, both depend only on `01` | if the mirror stalls, do the typedstream decoder |
| A | `04` and `05`, both depend on `02`+`03` | digest and voice pack in either order |
| B | `02`, `03`, `04` — all depend only on `01` | the committed fixtures decouple them completely |
| C | `02` and `03`, both depend only on `01` | adapter and inbound in either order |
| D | `02`, `03`, `04`, `05` — all depend only on `01` | four-way reorder after the schema |

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
