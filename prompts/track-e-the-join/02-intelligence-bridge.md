# Track E — Prompt 02: the drafts have never been made from a real digest

**Depends on:** nothing. Can run before or after `01`.

## Context

`cloud/brief/src/run.ts`:

```ts
/** Track B produces these. Supplied per user; this track consumes fixtures. */
gistsFor: (scope: UserScope) => Promise<Gist[]>;
draftsFor: (scope: UserScope) => Promise<Map<string, DraftBundle>>;
```

That comment is an honest description of a hole. Track B built `boi_intel` — threads,
gists, voice pack, drafter, validator, router — with its own tests and its own CLIs
(`python -m boi_intel.gist`, `python -m boi_intel.draft`). Track D built a brief composer
that takes gists and drafts as arguments. **Neither has ever seen the other's output.**

This is where the interesting failures live. Track B's `gist.v1` and Track D's consumption
of `Gist` were both written against the same frozen schema by two agents who never spoke.
Frozen schemas prevent *type* disagreements. They do not prevent Track B emitting three
gists where Track D expects them ranked, or `as_of` in a different precision, or a
`contact_id` computed from a differently-normalized handle.

**Expect to find at least one such disagreement. Record every one in `NOTES.md`.** If you
find none, say so explicitly and explain how you checked — "no disagreements found" with
no method behind it is the most likely wrong answer in this track.

## Objective

`gistsFor` and `draftsFor` are backed by a real invocation of `boi_intel` over a digest and
voice pack read out of the database.

## Scope

**In scope:**

- `cloud/intelligence-bridge/`: read the latest digest and voice pack for a scope, invoke
  `boi_intel`, return `Gist[]` and `Map<contact_id, DraftBundle>`.
- The invocation boundary: a subprocess call to the existing Python CLIs, JSON in and JSON
  out. **Do not port the intelligence to TypeScript** and do not add an HTTP service.
- Validation of what comes back against the frozen schemas, at the boundary, before it
  reaches the composer. A malformed gist is a dropped gist, not a thrown brief.
- The degradation path: Python missing, Python crashing, Python timing out, the model
  provider unavailable. Each produces **fewer or no drafts**, never a fabricated one, and
  never a failed brief when gists alone would still be worth sending.

**Explicitly out of scope:**

- A live Gemini call in tests. `BOI_MODEL_PROVIDER=fake` is the determinism control and it
  is what CI uses. One live call, run by hand and pasted into the report, is the evidence
  that the real provider works — see the DoD.
- Changing anything about how gists or drafts are produced. You are wiring, not tuning.
- Caching. Correct first.

## Constraints

- **Paths you may modify:** `cloud/intelligence-bridge/`, and **the `TickDeps` construction
  site only** in `cloud/brief/src/run.ts` — not `runForUser`'s body.
- **Paths you must not touch:** all of `intelligence/boi_intel/`, all of `mac/`.
  If the bridge needs something `boi_intel` does not expose, **stop and record it in
  `NOTES.md` rather than editing Track B's code.** That is a contract finding and it is
  worth more than the workaround.
- **Contracts:** `gist.v1`, `voice_pack.v1`, `draft_bundle.v1`, `digest.v1` — frozen.
- **Conventions:** `CONTRACTS.md` § 6, and the cross-language determinism rules in § 6.3 —
  the percentile and hash-payload pins exist so Swift and Python agree, and this bridge is
  where a disagreement would first become visible.

## The subprocess trap

Shelling out to Python from Node is easy to get 90% right. The 10%:

- **`stdout` is not the only thing Python writes.** `boi_intel` logs structured events.
  Parse the JSON from a file or a dedicated fd, not from a stream something else shares.
- **A non-zero exit with valid JSON on stdout is still a failure.** Check the exit code first.
- **A zero exit with empty stdout is a failure too**, and it is the one that looks like
  "this user had nothing to say." Distinguish *no gists* from *no answer*.
- **Timeouts must kill the child**, not just reject the promise. An orphaned model call
  holds a Gemini quota slot and a file handle.
- The voice pack contains the user's own sent messages. It goes to the child over a pipe
  or a `0600` temp file that is deleted in a `finally`. **Not on the command line** — argv
  is world-readable on macOS.

## Definition of Done

- [ ] `gistsFor(scope)` returns gists produced by a real `boi_intel` subprocess, from a digest that was inserted through `POST /v1/digest` — not from a fixture file
- [ ] `draftsFor(scope)` returns two candidate drafts per contact, each having passed Track B's validator, with `BOI_MODEL_PROVIDER=fake`
- [ ] **The test cannot pass without Python.** Rename or unset the interpreter and the test fails with a clear error. Demonstrate this in the report.
- [ ] Every returned gist validates against `gist.v1` and every bundle against `draft_bundle.v1`, checked at the bridge boundary
- [ ] A malformed gist is dropped and logged with its index and the validation error; the remaining gists still reach the composer
- [ ] Python crashing (exit 1) yields **zero drafts and a brief that still sends its gists** — assert the brief was sent
- [ ] Python hanging is killed at the timeout, the child process is confirmed reaped, and the tick fails cleanly rather than hanging the scheduler
- [ ] Zero exit with empty output is reported as `no_answer`, distinctly from `nothing_to_say`
- [ ] The voice pack never appears in `ps` output or in argv — assert it
- [ ] **One live call**, run by hand with a real `GEMINI_API_KEY`, producing two drafts that pass the validator. Paste the drafts in the report with the other party's content redacted.
- [ ] Every seam disagreement found is in `NOTES.md`, or the section says none were found and describes the method
- [ ] `npm test && npm run lint && npm run typecheck` exit zero; `python -m pytest` still exits zero
- [ ] `bash scripts/check-ownership.sh e` exits zero
