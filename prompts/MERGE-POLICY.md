# Merge Policy

This project is being built by several agents working in parallel, each in its own git
worktree on its own branch. That is only safe because there is exactly one point where
the work recombines, and the user holds it.

## The rule

**Do not merge your branch into the base branch. Do not open a pull request. Do not
push to the base branch. Do not rebase your branch onto the base branch.**

When your track's final prompt is complete and committed, **stop and report**, then
request the fresh-context review in `prompts/TRACK-REVIEW.md`. The order is: final
prompt committed → fresh review → user review → user merges. You do not review your own
work, and neither the working agent nor the reviewer merges anything.

Your report contains:

- What was built.
- The Definition of Done status for each prompt, with each item marked pass or fail.
- The evidence: test output, transcripts, screenshots, logs.
- Anything that deviated from the plan, and why.
- Anything you noticed that the plan did not anticipate.

The user reviews every track and decides when, in what order, and by what method the
merges happen.

**An agent that merges without explicit approval has failed the task regardless of how
good the code is.** This is not caution for its own sake. Merging early removes the
review that made the parallelism safe, and it does so at the exact moment the mistake
is hardest to see.

## What is permitted

**Committing inside your own worktree** — required, at the completion of every prompt.

**Pulling the base branch into your branch**, but only when the user explicitly
instructs it, typically after a contract amendment:

```bash
git merge <base>        # yes, when told to
git rebase <base>       # never
```

Use `git merge`, never `git rebase`. The user reads your commit history against the
Definition of Done, and rebasing rewrites it.

## What is never permitted, in any circumstance

- `git merge <your-branch>` while on the base branch
- `git push origin <your-branch>:<base>`
- `git rebase`, `git commit --amend`, `git push --force` on a track branch
- Opening a pull request
- Deleting or moving another track's worktree
- Editing files outside your track's owned paths, except appends to foundation-owned
  shared files as described in your TRACK.md

## For the fresh-context reviewer

The same rules bind you, with one clarification: you may **run** anything in the
worktree — tests, linters, the app — using this track's assigned ports and database.
You may not change any tracked file, commit, or merge. If running the suite leaves the
working tree dirty with untracked artifacts, say so in your report rather than cleaning
up tracked state.

## When you think the rule is wrong

You will occasionally hit a case where merging seems obviously correct — a trivial
fix, an unblocking one-liner, a change another track clearly needs right now. Those
are exactly the cases this rule exists for, because you cannot see what the other
agents are doing and the change is not trivial from where they sit.

Stop, commit, write it into `NOTES.md`, and report. The user merges.
