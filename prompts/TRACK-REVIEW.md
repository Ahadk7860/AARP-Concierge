# Track completion review

When your final prompt is committed, **do not review your own work.** Report to the user
and stop. The review that follows is not yours to run.

## The rule that does not change

**The agent that did the work never reviews the work.** It knows what it meant, it
remembers why each shortcut seemed fine, and it reads its own output as obviously
correct. Self-verification catches mechanical failure cheaply — a test that does not
pass, a lint rule that trips. It does not catch judgment failure, and it never catches
"the criterion was satisfied but the thing is wrong."

## Three passes, three different readers

A single reviewer cannot do this job, because the three questions worth asking need
opposite things. One needs a machine that can actually execute the suite. One needs
maximum ignorance. One needs maximum context. Give any two of them to the same reader
and you lose one.

```
final prompt committed
      |
      +-- Pass 1  Evidence     in the worktree, on the Mac    can run the tests
      +-- Pass 2  Diff audit   fresh context, no memory       can see a bent anchor
      +-- Pass 3  Alignment    the planning session           can see across tracks
      |
      +-- the user merges
```

**Nobody in any pass fixes anything, commits anything, or merges anything.** They report.
The user decides.

---

## Pass 1 — Evidence: re-run it, do not believe it

The working agent claimed a green checklist. Pass 1 exists because a claim is not an
artifact.

This pass **must happen in the worktree, on the Mac.** That is not a preference: the
planning session runs in a Linux container with no Swift, no Xcode and no local
Postgres, so it physically cannot execute Track A's suite or Track D's migrations. A
review that skips execution is a review of prose.

Run, from inside the track's worktree:

```bash
bash scripts/review-capture.sh <letter>
```

It re-runs the track's test, lint and ownership commands from a clean state and writes
everything the other two passes need — command output, `git log`, the diff stat,
`NOTES.md` — to `review-capture-<letter>.md` in the worktree. Hand that file to the
planning session.

If a command fails, that is the finding. Do not fix it and re-run.

---

## Pass 2 — Diff audit: try to fail this track

A **fresh agent, with no memory of this track's work and no access to the conversation
that produced the plan.** It receives only:

- `prompts/track-<x>-<slug>/TRACK.md`
- `prompts/CONTRACTS.md`
- every prompt file in this track
- `prompts/track-<x>-<slug>/NOTES.md`
- `git diff main...HEAD`
- the Pass 1 capture

It never receives the working agent's conversation, its reasoning, or its report.

### The instruction

1. **Correct?** Check each Definition of Done criterion against the diff and the Pass 1
   output. Do not accept the working agent's claim that it passed.
2. **Complete?** Does the diff do everything the prompts asked, or did scope quietly
   shrink between the prompt and the implementation?
3. **Honest?** Was any anchor bent — a test weakened, deleted, skipped or marked pending;
   a threshold lowered; an exception added; a type loosened; an assertion removed? Read
   the diff for this specifically. It is the failure mode self-verification cannot see.
4. **In bounds?** Is every path in `git diff --name-only main...HEAD` one of this track's
   owned paths, or a shared-file append recorded in `NOTES.md`? Was any frozen file
   touched?
5. **Contract-honoring?** Compare the implementation against `CONTRACTS.md` literally —
   shapes, names, status codes, error bodies.

### And one question only this pass can ask

**Was the criterion worth satisfying?**

Every Definition of Done in this repo was written by the planning session *before any
code existed*, and the planning session reviews in Pass 3. It cannot judge its own
criteria: a badly specified check looks correct to whoever specified it, and work that
satisfies a weak check reads as green from that seat.

So when a criterion is satisfied but the thing it was supposed to guarantee is not, say
so. That finding is the entire reason this pass has no memory, and it outranks everything
else in this list.

### Reviewer limits

- Report findings, not a blessing. "Nothing found" is legitimate only after a real
  attempt to break the work.
- **Fix nothing. Commit nothing. Merge nothing.**
- You may read anything in this worktree. If you also run things, use this track's
  assigned ports, database and cache directory — the working agent has stopped, so they
  are free. Never another track's.
- Running the suite may leave build artifacts behind. Leave tracked files untouched and
  say in your report if the working tree is no longer clean.

### If the track is high-stakes

Run the three judgment lenses — correct, complete, honest — as three separate passes
rather than one pass asked all three questions. Distinct lenses catch failure modes that
redundant identical passes do not. Run them sequentially in one session, or concurrently
only for lenses that read the diff without executing anything: three agents executing the
suite at once in one worktree contend for the same ports and build directory, which is
the collision the runtime-resource rule exists to prevent.

---

## Pass 3 — Alignment: does this still add up to the product?

The **planning session** — the conversation that wrote the brief, the architecture, the
contracts and these prompts. It has context nobody else does, and it is the only reader
who can answer a question no track can ask about itself.

Passes 1 and 2 ask whether a track did what it was told. Pass 3 asks whether what it was
told was still right, given what the other three tracks turned out to build.

It reads the Pass 1 capture, the Pass 2 findings, `NOTES.md` and the diff, and asks:

- **Does this contradict another track?** Two tracks can both honour the contract and
  still disagree — different retry semantics, different definitions of "stale," two
  incompatible readings of the same field.
- **Is the contract still right?** A contract gap in `NOTES.md` is a scheduled
  conversation, not a complaint. Every `UNRESOLVED` item this track touched is
  re-examined here.
- **Does it hold the product line?** Invitation and never verdict. Never auto-send.
  `is_from_me = 1`. `as_of` on every fact. Degrade, never fabricate. No reciprocity, in
  any form, anywhere. These are not style preferences, and a track can satisfy every
  criterion while quietly crossing one.
- **What did this track learn that changes the plan?** The `## Observations` section of
  `NOTES.md` is often the most valuable thing produced all day, and it is addressed to
  nobody in particular unless somebody reads it across all four tracks.

Pass 3 may make **surgical edits to the plan** — a contract amendment, a prompt
correction, a resequenced dependency — through the amendment procedure in
`WORKTREE-PROTOCOL.md`. It does not edit track code, and it does not merge.

Its output is a merge recommendation and a list of what changed in the plan.

---

## What the user does

Read Pass 2's findings and Pass 3's recommendation, then merge in an order you choose.
Nothing merges on its own, and no pass has the authority to skip a step.

> **Do not merge this branch. Do not open a pull request. Do not touch the base branch.
> Stop and report when the track is done.** Full rule: `prompts/MERGE-POLICY.md`.
