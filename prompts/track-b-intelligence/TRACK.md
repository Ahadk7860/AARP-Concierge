# Track B — Intelligence — the drafter

## The project

Boi is a consumer AI assistant that lives in iMessage. A companion Mac app reads the
user's local iMessage history, so Boi is the only assistant that knows their
*relationships* — who they're close to, who they're losing, who is waiting on a reply
right now. Each morning it texts a brief of at most three people, and for each one it
drafts **two** candidate messages in the user's own voice. It never sends them; the
user does. Done, for this round, means: the Mac app produces a valid digest and voice
pack from a real message history; the drafter produces two sendable messages that
sound like the user; the cloud can compose and deliver a brief over a channel
abstraction that a real Linq token will slot into later.

**Repo:** skylerluk/boi-imessage
**Base branch:** `main`
**This track's branch:** `track-b-intelligence`
**This track's worktree:** `/Users/skylerluk/Dev/boi-imessage-track-b`

## Your mission

Own the new capability. Turn a thread the user has left hanging into **two candidate
messages that sound like them**, and prove on evidence that they do.

Four components, in dependency order of risk rather than of code: the voice-pack builder
(which is also Track A's oracle), the gist producer, the drafter and its model router,
and the validator. Then the eval harness that decides which model to use — because the
harness is the only thing that can decide it, and benchmarks cannot.

Everything in this track runs **offline against a local database and committed
fixtures**. It never needs the cloud, and it never needs Linq.

## What you own

You may create and modify only these paths:

- `intelligence/** — except the two frozen files named below`

## What you must not touch

These belong to other tracks. Editing them causes merge conflicts that are expensive to
untangle, and the other agent is working in them right now.

- `mac/**` — Track A
- `cloud/**` — Tracks C and D
- `intelligence/boi_intel/contracts.py` — **frozen**
- `intelligence/boi_intel/providers/fake.py` — **frozen**
- `prompts/CONTRACTS.md` — frozen, user-owned
- `contracts/**` — frozen, user-owned

If your work seems to require changing something on this list, that is a signal the
plan is wrong. Stop and report rather than reaching across the boundary. If what you
need is an entry in a file another track owns — a generated project file, a field on
their type — record it in `NOTES.md` under `## Requests to other tracks` and report.

## Shared files — foundation-owned, append-only

These belong to no track, and you will need to add to some of them:

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `pyproject.toml`
- `.env.example`, `.gitignore`, root `README.md`
- `scripts/**`, and all of `prompts/**` other than your own track folder

**Your own folder is yours** for exactly two edits: writing `NOTES.md`, and updating
the `Status` column of the prompt table in this file. Do not change anything else in
your brief or your prompt files.

You may **append** — add a dependency, add a variable. You may not reorder, reformat,
remove from, or restructure them. Record every append in `NOTES.md` under
`## Shared file changes` so the user can anticipate merge conflicts. Never hand-edit a
lockfile; regenerate it with the project's tool.

The baseline dependencies for every track are already in the manifests, deliberately,
so appends should be rare. If you find yourself needing many, say so — it usually means
the plan underestimated something.

### Frozen — you may not modify these at all

`scripts/check-ownership.sh` fails on any change to `contracts/**`,
`cloud/shared/src/**`, `intelligence/boi_intel/contracts.py`,
`intelligence/boi_intel/providers/fake.py`, `mac/Sources/BoiKit/Contracts.swift`, or
the four rule files in `prompts/`. These are the surface the other three tracks are
coding against right now. If one is wrong, that is a contract gap: commit, record it in
`NOTES.md`, report, and stop.

## Contracts you consume

From `prompts/CONTRACTS.md`, code against these exactly:

- `voice_pack.v1` — you write the reference implementation, Track A ships the Swift port
- `gist.v1` and `draft_bundle.v1` — `contracts/schema/`, frozen
- `FakeProvider` — `intelligence/boi_intel/providers/fake.py`, replaying `contracts/transcripts/model/`
- the synthetic `chat.db` from `scripts/make_synthetic_chatdb.py`

Until those tracks land their real implementations, develop against the stubs and
fixtures from the foundation commit. They are already on your branch — they landed on
`main` before your worktree was created, so you have them. You never need to reach into
another track's worktree, and you must not try.

Language-neutral artifacts you can use without running another track's code:
`contracts/schema/*.json`, `contracts/fixtures/**`, `contracts/openapi/*.yaml`,
`contracts/transcripts/**`, and `python3 scripts/validate_fixtures.py`.

## Contracts you produce

Other tracks are coding against these right now. Changing their shape breaks work
already in progress, so treat them as a published API:

- `gist.v1` documents — consumed by Track D
- `draft_bundle.v1` documents — consumed by Track D, embedded in `brief.v1`
- the voice-pack reference implementation — **the test oracle for Track A's Swift port**

## Dependencies

- **Blocked on:** nothing. The foundation commit contains every contract, stub and
  fixture you need. Start immediately.
- **Blocks:** nobody, in this round. Track D develops against `contracts/fixtures/draft_bundle/`.

## Stack and conventions

- Language: Python 3.11+.
- Test command: `python -m pytest`
- Lint command: `ruff check intelligence && ruff format --check intelligence`
- Run command: `python -m boi_intel.<module>` — you create the CLIs
- Conventions: follow `CONTRACTS.md` § 6 without deviation.

## Your runtime resources

These are yours alone. Three other tracks are running at the same time and have their
own. Do not use a default port, a shared database name, or a shared data directory —
file ownership does not prevent runtime collisions.

- **Port range:** 3020–3029 (you should not need one)
- **Scratch / output:** `/tmp/boi-b`
- **Fixture database:** `/tmp/boi-b/chat.db`, from `python3 scripts/make_synthetic_chatdb.py --out /tmp/boi-b/chat.db`
- **Live APIs — you are the only track permitted them.** Gemini, with `BOI_MODEL_PROVIDER=gemini` **and** `BOI_ALLOW_LIVE_CALLS=1`. Kimi's key is not provisioned; use `FakeProvider`.
- **The default test path is `FakeProvider`.** Live calls belong in the eval harness, never in the unit suite. A suite that needs a network is a suite that fails randomly.

If you need a resource not listed here, it is unassigned. Record it in `NOTES.md` and
report rather than picking a default that another track may also pick.

## Your prompts

| # | File | Outcome | Depends on | Status |
|---|---|---|---|---|
| 01 | `01-voice-pack.md` | voice packs from a chat.db, with zero inbound leakage | none | not started |
| 02 | `02-gist.md` | gist.v1 from a thread, with a fallback that needs no model | 01 | not started |
| 03 | `03-drafter.md` | a drafter and model router producing draft_bundle.v1 | 01 | not started |
| 04 | `04-validator.md` | deterministic gates that refuse bad drafts | 01 | not started |
| 05 | `05-eval-harness.md` | a model bake-off decided on evidence, not benchmarks | 03, 04 | not started |

**Read the `Depends on` column, not the numbering.** Numbering implies a sequence and
most of that sequence is imaginary. A prompt whose dependencies are complete is ready,
regardless of its number — so if `02` is blocked and `03` depends only on `01`, start
`03`. Two prompts that write the same file have an edge even when neither reads the
other's output; those are marked explicitly.

Complete one prompt fully — self-verification, evidence, commit — before opening
another. Do not batch two prompts into one commit.

### The one thing to get right about this track

The obvious way to build this is to send the thread to a frontier model and ask it to
write like the user. That costs orders of magnitude more, leaks the corpus, and produces
**worse** drafts — because a frontier model's instinct is to write *well*, and the
requirement is to write *like them*.

The design that works instead rests on an asymmetry: **the voice we imitate is the
user's own; the content we must understand is somebody else's.** Those separate. The
user's sent messages go to the cloud (they are the user's own words, and there is no
third party). The other person's messages stay on the Mac and become a gist. The
drafter's context is *your words, their meaning*.

Every part of this track exists to hold that line.

### And do not spend a day choosing a model

All four candidates land between **$0.03 and $0.44 per user per month** — one to two
orders of magnitude inside budget. Cost is not the deciding variable; register fidelity
is, and only the eval harness in `05` can measure it. Switching models afterwards is an
afternoon.

## How you work

1. Read this file and `prompts/CONTRACTS.md` before starting.
2. Open prompt `01`. Do only what it asks.
3. Run its Definition of Done checklist yourself. If anything fails, fix it and run
   again. Repeat until every item passes or you are genuinely blocked.
4. Gather the required evidence.
5. Commit inside this worktree.
6. Report to the user: the checklist with each item's status, the evidence, anything
   that deviated from the plan, and anything you noticed that the plan did not
   anticipate.
7. **Wait for the go-ahead** before starting the next prompt.

## Commit discipline

- Commit at the completion of every prompt. Every stage, without exception. Not at the
  end of the track, not "once it's working."
- Message format: `track-b: <NN> <slug> — <what changed>`
- Multiple passes on one prompt means multiple commits. The history is what the user
  reviews against the Definition of Done, so it should show the real path.
- Never rebase, squash, amend, or force-push this branch.

## When you are blocked

Do not guess and do not work around it silently. A silent workaround in a parallel
track is discovered at integration, which is the most expensive moment to discover
anything.

1. Commit what works so far, with a message noting the blocker.
2. Write the problem into `NOTES.md` in this folder: what you were doing, what you
   expected, what happened, what you tried.
3. Report to the user and stop.

Escalate immediately, rather than working around, when: a contract in `CONTRACTS.md` is
wrong or insufficient; the work requires touching a forbidden path; a dependency is
missing; or the Definition of Done cannot be satisfied as written.

## Track completion review

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

Summary: **the agent that did the work never reviews the work.** When your final prompt
is committed, report and request a fresh-context review. Full procedure:
`prompts/TRACK-REVIEW.md`.

## Merge policy

> **Do not merge this branch. Do not open a pull request. Do not touch the base
> branch. Stop and report when the track is done.** Full rule:
> `prompts/MERGE-POLICY.md`.

Read `prompts/MERGE-POLICY.md` before your first commit. It is the canonical text and
covers the one permitted exception: pulling the base branch into yours with
`git merge`, only when the user instructs it, never with `git rebase`.
