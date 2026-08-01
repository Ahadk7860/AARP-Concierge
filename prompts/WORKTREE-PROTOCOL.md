# Worktree Protocol

## Why worktrees rather than branches

A branch shares one working directory. Two agents on two branches in one directory
means constant checkout thrashing, and an agent that checks out while another is
mid-edit will silently lose work. Worktrees give each agent its own directory on its
own branch against one shared object database. They can run, test, and commit
simultaneously without any awareness of each other.

## Setup

Run from the repo root, on a clean base branch, **after the foundation commit has
landed on that base branch and been pushed.** This ordering is not cosmetic: it is the
only reason every worktree carries the same contracts, stubs, fixtures, and plan. A
stub committed on Track A's branch is unreachable from Track B, which is forbidden to
touch either the base branch or a sibling branch — so a foundation that lands anywhere
but the base branch does not propagate at all.

```bash
# verify the base is clean and current first
git status --porcelain    # expect empty output
git checkout <base>
git pull                  # must include the foundation commit

# one worktree per track
git worktree add <worktree-root>/<project>-track-a -b track-a-<slug>
git worktree add <worktree-root>/<project>-track-b -b track-b-<slug>
git worktree add <worktree-root>/<project>-track-c -b track-c-<slug>

git worktree list          # confirm
```

Each agent is launched with its working directory set to its own worktree path and
stays there for the life of the track. An agent that finds itself outside its worktree
should stop and report.

Per-worktree setup an agent may need before its first prompt — installing
dependencies, copying `.env.example` to `.env` — belongs in that track's prompt `01`,
because worktrees do not share untracked files or installed dependencies.

## Commit discipline

- **Commit at the completion of every prompt.** Every stage. Not at the end of the
  track. Not "once it's working."
- Message format: `track-<letter>: <NN> <slug> — <what changed>`
- Multiple passes on a single prompt produce multiple commits. That is correct. The
  history is the audit trail the user reads against the Definition of Done, and a
  history that shows only clean successes is a history that has been laundered.
- **Never** rebase, squash, amend, or force-push a track branch.
- Commit before reporting a blocker, with the blocker named in the message.

## The merge prohibition

The canonical text lives in one place: `prompts/MERGE-POLICY.md`. Every other file
quotes the short form and links there. Do not write variant phrasings.

Short form:

> **Do not merge this branch. Do not open a pull request. Do not touch the base
> branch. Stop and report when the track is done.** Full rule:
> `prompts/MERGE-POLICY.md`.

Parallel tracks are only safe because the user holds the single point at which the
work recombines. An agent that merges early removes the review that made the
parallelism safe, at the exact moment the mistake is hardest to see.

## Cleanup — only after the user has approved and merged

The user runs these, not an agent:

```bash
git worktree remove <worktree-root>/<project>-track-a
git branch -d track-a-<slug>
git worktree prune
```

## Recovery

**Agent modified a forbidden path.** Do not resolve it inside the track. Report it.
The user decides whether to revert the file or reassign ownership, because the other
track may already have work in flight against it.

**Two tracks turn out to need the same file.** The decomposition was wrong. Stop both
tracks, fix the ownership map and CONTRACTS.md, and re-brief. Do not let two agents
negotiate a shared file at runtime — they cannot see each other.

**A contract is wrong.** Every track consuming it is now building against a false
assumption, so this is the one change that cannot propagate quietly. The sequence:

1. Stop every affected track. Each commits its work in progress and records the gap
   in `NOTES.md` under `## Contract gaps`.
2. The user amends `prompts/CONTRACTS.md`, updates the affected stubs and fixtures,
   commits to the base branch, and pushes.
3. The user then instructs each affected track to pull the amendment forward:

```bash
git merge <base>     # forward merge only, and only when instructed
```

Never `git rebase` — the user reads the commit history against each Definition of
Done, and rebasing rewrites it. This forward merge is the single exception to "do not
touch the base branch," and it moves in one direction only: base into track, never
track into base.

4. Each track re-runs its completed Definitions of Done against the amended contract
   before resuming new work. A contract change can retroactively break a prompt that
   was green.
