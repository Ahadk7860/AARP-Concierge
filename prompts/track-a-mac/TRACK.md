# Track A — The Mac app

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
**This track's branch:** `track-a-mac`
**This track's worktree:** `/Users/skylerluk/Dev/boi-imessage-track-a`

## Your mission

Own the sensor. Read the user's local `chat.db`, call history and contacts; keep a
durable local mirror; compute the metric library in plain SQL; run the health check that
decides whether this user's data is even usable; extract the voice pack; and write a
valid `digest.v1` and `voice_pack.v1` to disk. **No network, no account, no cloud.**

This is the demo and it is the critical path. It is also the track where a bug is
silent: four of the traps below produce no error, pass on a quiet test machine, and lose
half the corpus on a live iCloud-syncing Mac.

## What you own

You may create and modify only these paths:

- `mac/**`

## What you must not touch

These belong to other tracks. Editing them causes merge conflicts that are expensive to
untangle, and the other agent is working in them right now.

- `intelligence/**` — Track B
- `cloud/**` — Tracks C and D
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

- `digest.v1` and `voice_pack.v1` schemas — `contracts/schema/`, frozen
- `POST /v1/digest`, `POST /v1/voice-pack`, `POST /v1/pair` — Track D. **You do not call them in this round**; write the digest to disk.
- `mac/Sources/BoiKit/Contracts.swift` — frozen Swift mirror of the schemas

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

- `digest.v1` documents — consumed by Track D
- `voice_pack.v1` documents — consumed by Track B and Track D
- the voice-pack extraction logic, which must agree with Track B's Python reference implementation on the same input

## Dependencies

- **Blocked on:** nothing. The foundation commit contains every contract, stub and
  fixture you need. Start immediately.
- **Blocks:** nobody, in this round. Track D develops against `contracts/fixtures/digest/`.

## Stack and conventions

- Language: Swift 5.9, macOS 13+. SwiftUI for the app shell in `07`.
- Test command: `swift test --package-path mac`
- Lint command: `swift build --package-path mac -Xswiftc -warnings-as-errors`
- Run command: `swift run --package-path mac boi-cli -- <subcommand>` (you create the CLI in `01`)
- Conventions: follow `CONTRACTS.md` § 6 without deviation.

## Your runtime resources

These are yours alone. Three other tracks are running at the same time and have their
own. Do not use a default port, a shared database name, or a shared data directory —
file ownership does not prevent runtime collisions.

- **Port range:** 3010–3019 (you should not need one)
- **Scratch / output:** `/tmp/boi-a` — everything you generate goes here, nothing is committed
- **Fixture database:** `/tmp/boi-a/chat.db`, from `python3 scripts/make_synthetic_chatdb.py --out /tmp/boi-a/chat.db`
- **Local mirror:** `/tmp/boi-a/mirror.db`
- **Live APIs:** none. You make no network calls in this round at all.

If you need a resource not listed here, it is unassigned. Record it in `NOTES.md` and
report rather than picking a default that another track may also pick.

## Your prompts

| # | File | Outcome | Depends on | Status |
|---|---|---|---|---|
| 01 | `01-reader.md` | a CLI that reads the fixture database and proves the WAL is visible | none | **done** — DoD green, 23 tests pass |
| 02 | `02-mirror.md` | SQLite + FTS5 mirror with a watermark that survives backfill | 01 (consumes the reader; same files) | **done** — DoD green, 42 tests pass |
| 03 | `03-typedstream.md` | attributedBody decoded; unrecoverable share drops below 2% | 01 (consumes the reader; same files) | not started |
| 04 | `04-metrics-digest.md` | a valid digest.v1 written to disk from real message history | 02, 03 | not started |
| 05 | `05-voice-pack.md` | valid voice_pack.v1 with zero inbound leakage | 02, 03 | not started |
| 06 | `06-health-check.md` | healthy / fixable / thin, with a repair path | 04 | not started |
| 07 | `07-app-bundle.md` | a launchable .app with FDA onboarding and a working LaunchAgent | 06 | not started |

**Read the `Depends on` column, not the numbering.** Numbering implies a sequence and
most of that sequence is imaginary. A prompt whose dependencies are complete is ready,
regardless of its number — so if `02` is blocked and `03` depends only on `01`, start
`03`. Two prompts that write the same file have an edge even when neither reads the
other's output; those are marked explicitly.

Complete one prompt fully — self-verification, evidence, commit — before opening
another. Do not batch two prompts into one commit.

### The traps, all of which are silent

Every one of these passes on a quiet test machine and fails on a live Mac. They are the
reason this track is sequenced the way it is.

| Trap | What happens | Rule |
|---|---|---|
| `immutable=1` on the SQLite URI | WAL ignored, corpus permanently frozen, **no error** | `mode=ro` only |
| Watching the file instead of polling | WAL and SHM rotate inodes on checkpoint; the watcher is orphaned forever | Poll. Never `FSEvents` on the sidecars. |
| `MAX(ROWID)` as the watermark | backfilled messages arrive with *new* ROWIDs and *old* dates, and are silently skipped | ROWID **plus** a trailing 30-day re-scan, dedup by `guid` |
| Naive `attributedBody` decoding | ~47% of messages lost; reads as "the report is thin," not as a bug | a correct typedstream deserializer |
| Merging contacts on the handle string | one person splits into two rows and corrupts the top of the ranking | merge on the AddressBook record ID. *Known bug in the existing Python prototype.* |
| LaunchAgent as a separate binary | TCC is per-responsible-process and children do **not** inherit; sync silently never runs | the agent invokes the main app binary with `--sync` |
| LaunchDaemon instead of LaunchAgent | root processes cannot hold TCC at all on macOS 13+ | Agent, always |

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
- Message format: `track-a: <NN> <slug> — <what changed>`
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
