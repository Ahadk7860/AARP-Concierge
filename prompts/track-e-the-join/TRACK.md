# Track E — The Join

**The other four tracks each built a working half of a pipe. Nobody has ever run water
through it.** That is this track, and it is the only track whose failures are *between*
files rather than inside them.

## Why this is one track and not four

Tracks A–D were parallel because their seams were frozen contracts, and a frozen contract
lets two people work without talking. This track exists precisely because those contracts
have never been exercised against each other by anything but fixtures. Splitting it would
recreate the problem it exists to solve.

One session. One branch. One prompt at a time. No worktree — everything else has merged,
so you work on a branch off `main` and there is nobody to conflict with.

## The four gaps, named

Found by reading `main` after all four merges, 3 Aug:

1. **The Mac never uploads.** `grep -rl "URLSession" mac/Sources/` returns nothing. There
   is no HTTP client anywhere in the Swift target. `SyncRun` writes `out/digest.json` and
   the voice pack to disk and stops. The cloud has never received a byte from a Mac.
2. **The intelligence is never invoked.** `cloud/brief/src/run.ts` takes `gistsFor` and
   `draftsFor` as injected dependencies, with the comment *"Track B produces these. This
   track consumes fixtures."* Nothing reads a stored digest out of the database, hands it
   to `boi_intel`, and returns real gists and drafts.
3. **The card is never rendered.** `composeBrief` accepts `card_url` as an input. No
   caller supplies one. `cloud/card/` renders beautifully and is called by its own tests.
4. **Nothing runs the chain.** There is no process, script or test that goes signup →
   sync → upload → gists → drafts → card → brief → send.

Gaps 1–3 are missing edges between built nodes. Gap 4 is the thing that would have found
1–3 on day one.

## Owned paths

- `mac/Sources/BoiKit/Uploader.swift`, `mac/Sources/BoiKit/UploadQueue.swift` and their tests
- `cloud/intelligence-bridge/`
- `cloud/e2e/`
- `cloud/channel/src/spectrum-channel.ts`, `cloud/channel/src/spectrum-signature.ts`
- Narrow, named edits inside `mac/Sources/BoiKit/SyncRun.swift`, `mac/Sources/BoiCLI/main.swift`,
  `cloud/brief/src/run.ts` and `cloud/brief/src/compose.ts` — each one called out in the
  prompt that needs it. **Nothing else in those files.**

## The one frozen-file change this track is allowed

`InboundMessage.provider` in `cloud/shared/src/contracts.ts` gains `"spectrum"`. It is a
union widening, so nothing that compiles today stops compiling. It lands in prompt `04`
and nowhere else. Record it in `NOTES.md`.

Everything else in `cloud/shared/src/contracts.ts`, `intelligence/boi_intel/contracts.py`
and `mac/Sources/BoiKit/Contracts.swift` remains frozen.

## The anchor for this track

> **A join that passes because both sides were stubbed is not a join.**

Every criterion in this track must be satisfiable only by data that actually crossed a
process boundary. If a test can pass with the Python interpreter uninstalled, it is not
testing the intelligence bridge. If it can pass with the API server down, it is not
testing the uploader. Where a criterion could be met either way, the prompt says which.

## Reporting

Same as every other track: the three-pass review in `prompts/TRACK-REVIEW.md`. Pass 1 is
evidence from your own machine, pass 2 is a fresh-context diff audit with no memory of
having written the code, pass 3 is alignment, done by the review chat.
