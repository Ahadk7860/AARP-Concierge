# Track completion review

When your final prompt is committed, **do not review your own work.** Report to the
user and request a fresh-context review.

## Who reviews

A **new agent, in a new session, with no memory of this track's work**, started in this
same worktree. It receives only:

- `prompts/track-<x>-<slug>/TRACK.md`
- `prompts/CONTRACTS.md`
- every prompt file in this track
- `prompts/track-<x>-<slug>/NOTES.md`
- `git diff <base>...HEAD`

It never receives the working agent's conversation, its reasoning, or its report.

## The instruction: try to fail this track

1. **Correct?** Verify each Definition of Done criterion yourself by running it. Do
   not accept the working agent's claim that it passed.
2. **Complete?** Does the diff do everything the prompts asked, or did scope quietly
   shrink between the prompt and the implementation?
3. **Honest?** Was any anchor bent — a test weakened, deleted, skipped, or marked
   pending; a threshold lowered; an exception added; a type loosened; an assertion
   removed? Read the diff for this specifically. It is the failure mode
   self-verification cannot see.
4. **In bounds?** Is every path in `git diff --name-only <base>...HEAD` one of this
   track's owned paths, or a shared-file append recorded in `NOTES.md`?
5. **Contract-honoring?** Compare the implementation against `CONTRACTS.md` literally —
   shapes, names, status codes, error bodies.

## Reviewer limits

- Report findings, not a blessing. "Nothing found" is legitimate only after a real
  attempt to break the work.
- **Fix nothing. Commit nothing. Merge nothing.** You may run tests and read anything
  in this worktree; you may not change tracked files.
- Running the suite may leave build artifacts or scratch files behind. Leave tracked
  files untouched and say in your report if the working tree is no longer clean.
- You use this track's assigned ports, database, and cache directory — the working
  agent has stopped, so they are free. Do not use another track's.

## If the track is high-stakes

Run the three judgment lenses — correct, complete, honest — as three separate passes
rather than one pass asked all three questions. Distinct lenses catch failure modes
that redundant identical passes do not.

Run them **sequentially in one session**, or concurrently only for lenses that read the
diff without executing anything. Three agents executing the test suite at once in one
worktree contend for the same ports, database, and build directory — the same collision
the runtime-resource rule exists to prevent.
