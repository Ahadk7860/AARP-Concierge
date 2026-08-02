# Boi — parallel build plan

## The project

Boi is a consumer AI assistant that lives in iMessage. A companion Mac app reads the
user's local iMessage history, so Boi is the only assistant that knows their
*relationships* — who they're close to, who they're losing, who is waiting on a reply
right now. Each morning it texts a brief of at most three people, and for each one it
drafts **two** candidate messages in the user's own voice. It never sends them; the user
does.

> Every AI assistant can read your calendar. Boi is the only one that can read the room.

**Repo:** skylerluk/boi-imessage
**Base branch:** `main`
**Foundation commit:** contracts, schemas, stubs, fixtures, harness, and this folder
**Track shape:** **mixed** — layered by toolchain, because Swift, Python and TypeScript
each need their own test runner and lint config, with the TypeScript layer split into two
verticals that meet at exactly one frozen interface

## Tracks

| Track | Name | Owns | Branch | Worktree | Prompts | Ports |
|---|---|---|---|---|---|---|
| A | The Mac app | `mac/**` | `track-a-mac` | `/Users/skylerluk/Dev/boi-imessage-track-a` | 7 | 3010-3019 |
| B | Intelligence - the drafter | `intelligence/**` | `track-b-intelligence` | `/Users/skylerluk/Dev/boi-imessage-track-b` | 5 | 3020-3029 |
| C | Transport - the channel spine | `cloud/channel/**, cloud/mock-linq/**` | `track-c-transport` | `/Users/skylerluk/Dev/boi-imessage-track-c` | 4 | 3030-3039 |
| D | Cloud - the product surface | `cloud/api|brief|card|db/**` | `track-d-cloud-surface` | `/Users/skylerluk/Dev/boi-imessage-track-d` | 6 | 3040-3049 |

**The letters carry no dependency meaning past A.** Track A is lettered first because it
owns the largest share of the frozen contract surface and is the critical path — not
because anything waits on it. B, C and D are mutually independent, and independent of A.

Full runtime-resource partition — databases, scratch directories, container prefixes,
rate-limited APIs — is in `CONTRACTS.md` § 9. No track uses a framework default.

## Execution order

**Can start immediately:** all four. The foundation commit contains every contract, stub
and fixture, so nothing is waiting on anything.

**Gated:** nothing.

Suggested order if you are running fewer sessions than tracks: **A, then B, then D, then
C.** A is the critical path and has the most prompts. B is the new capability and carries
the most product risk. D is large but every prompt is verifiable against fixtures. C is
last only because its real verification is blocked on a Linq token regardless of when you
build it.

## Foundation

Everything every track needs on day one is already on `main`:

- JSON Schemas for all seven shared shapes, in `contracts/schema/`
- Language mirrors in TypeScript, Python and Swift — all frozen
- `StubChannel` (TypeScript) and `FakeProvider` (Python), so no track runs another's code
- A synthetic `chat.db` generator with the real schema, NULL-text rows, tapbacks, a group
  chat, and **an open WAL**
- Static fixtures for every shape, plus Linq and model transcripts including two
  deliberate violations
- `scripts/validate_fixtures.py` — validates any document from any language
- `scripts/check_voice_pack_leak.py` — the third `is_from_me` guard
- `scripts/check-ownership.sh` — ownership and frozen-file enforcement
- Test runner and lint config per toolchain, each with a passing test
- `.env.example` covering every variable in `CONTRACTS.md`

No track waits on another track's real implementation.

## Shared files — foundation-owned, append-only

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `pyproject.toml`
- `.env.example`, `.gitignore`, root `README.md`
- `scripts/**`
- `prompts/**` — **except** that each track owns its own `prompts/track-<letter>-<slug>/`
  folder for exactly two edits: writing `NOTES.md`, and updating the `Status` column of
  its own prompt table in `TRACK.md`

A track may **append**, and records every append in its `NOTES.md` under
`## Shared file changes`. No track reorders, reformats, removes from, or restructures.
Never hand-edit a lockfile.

**Frozen — not modifiable at all:** `contracts/**`, `cloud/shared/src/**`,
`intelligence/boi_intel/contracts.py`, `intelligence/boi_intel/providers/fake.py`,
`mac/Sources/BoiKit/Contracts.swift`, and the four rule files here.
`scripts/check-ownership.sh` fails on any change to them.

## The rule files

Each has exactly one text. Nothing anywhere paraphrases them.

| File | What it governs |
|---|---|
| `CONTRACTS.md` | the frozen shared surface every track codes against |
| `MERGE-POLICY.md` | what an agent may and may not do with git |
| `TRACK-REVIEW.md` | the fresh-context review every track ends with |
| `WORKTREE-PROTOCOL.md` | worktree setup, commit discipline, recovery procedures |

The frozen-anchors rule has no file of its own: it is inserted verbatim into all 22
prompt files, under Self-verification.

## Getting started

**Follow `LAUNCH.md`.** It has the setup command, the launch order, the folder each
session opens in, and the exact message to paste into each one.

## Commit discipline

- Commit at the completion of **every** prompt. Every stage. Not at the end of the track,
  not "once it's working."
- Format: `track-a: 03 typedstream — <what changed>`
- Multiple passes on one prompt means multiple commits. That is correct — the history is
  the audit trail reviewed against each Definition of Done.
- Never rebase, squash, amend, or force-push a track branch.

## Merge policy

> **Do not merge this branch. Do not open a pull request. Do not touch the base branch.
> Stop and report when the track is done.** Full rule: `prompts/MERGE-POLICY.md`.

## How a track gets reviewed

**Three passes, three different readers, then you merge.** A single reviewer cannot do
this job: one question needs a machine that can execute the suite, one needs maximum
ignorance, one needs maximum context. Give any two to the same reader and you lose one.
Canonical procedure: `TRACK-REVIEW.md`.

| Pass | Who | Why them |
|---|---|---|
| 1 — Evidence | you, in the worktree, via `scripts/review-capture.sh` | only the Mac can run Swift, Xcode and Postgres |
| 2 — Diff audit | a fresh agent with no memory of the plan | only it can see a bent anchor, or a criterion that was satisfied while the thing stayed broken |
| 3 — Alignment | the planning session | only it can see across all four tracks and back to the brief |

The working agent reviews nothing. **No pass fixes, commits, or merges** — they report,
and you decide.

Pass 3 may make surgical edits to `prompts/` and `contracts/` through the amendment
procedure in `WORKTREE-PROTOCOL.md`. If it does, forward-merge `main` into every affected
worktree before anyone resumes.

## Status

| Track | Prompt | Status | Reviewed |
|---|---|---|---|
| A | 01 | not started | — |
| A | 02 | not started | — |
| A | 03 | not started | — |
| A | 04 | not started | — |
| A | 05 | not started | — |
| A | 06 | not started | — |
| A | 07 | not started | — |
| B | 01 | not started | — |
| B | 02 | not started | — |
| B | 03 | not started | — |
| B | 04 | not started | — |
| B | 05 | not started | — |
| C | 01 | not started | — |
| C | 02 | not started | — |
| C | 03 | not started | — |
| C | 04 | not started | — |
| D | 01 | not started | — |
| D | 02 | not started | — |
| D | 03 | not started | — |
| D | 04 | not started | — |
| D | 05 | not started | — |
| D | 06 | not started | — |
