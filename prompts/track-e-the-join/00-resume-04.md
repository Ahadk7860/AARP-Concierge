# Track E — resuming prompt 04

The previous session reached its context limit and stopped cleanly at **`b3229cc`**, tree
clean, commit message marked WIP. It did not pretend to be finished, which is why you can
trust the list below.

## Read first

`TRACK.md`, `prompts/CONTRACTS.md`, `NOTES.md` (all of it — the contract-ambiguity table
is the real history of this track), then `04-card-and-runner.md`.

You are on branch `track-e`. No worktree. `git log --oneline main..track-e` is your context.

## What is already true

`npm run e2e` runs the product end to end: empty database → migrate → synthetic `chat.db`
→ signup → pair → a real `boi-cli sync-run` (read, mirror, digest, voice packs, HTTP
upload) → gists from the stored digest → drafts → card → compose → deliver →
`StubChannel`. Four messages, three items, artifacts and a seam report per run.

`contact_id` holds across digest → gists → drafts → brief for every item, asserted.
AMENDMENT-001's four fields work on a real corpus through a real upload.

## What is outstanding

Four things. The first is new and is the most important.

1. **Gap 5: the card never reaches the user.** `composeBrief` sets `brief.card_url` and
   `deliverBrief` never reads it — `deliver.ts` emits text blocks only, and a grep for an
   image block over what the channel received returns nothing. **`deliver.ts` is now
   granted to this track for this fix and nothing else.**

   Note how this survived: the DoD said "a `card_url` that resolves", and it did — in the
   stored brief. Asserting on the artifact instead of on the blocks the channel received
   is what let the renderer, the compose edge and the stored brief all be green while the
   product's acquisition loop was silently absent. The corrected DoD line says so.

2. Renderer down → `card_url: null` and the brief still sends. The code path exists and is
   commented; it is not asserted.
3. Double-run idempotency — two `npm run e2e` runs send once.
4. `bash scripts/gate.sh e`, which has never been run on this work. The gate now refuses a
   dirty tree, so commit first.

## Two things the previous session learned that you should not re-learn

**An artifact that cannot show a defect is not evidence.** The first version of the runner
wrote the tick's return value — three counters — to `brief.json`. There was no card field
to be empty, so gap 5 was invisible. The artifact was changed to the real document and the
gap appeared immediately. Apply that test to every artifact you add.

**The first `npm run e2e` exited zero having executed nothing.** The entry guard tested
`process.argv[1]`, which under `vite-node` is the runner rather than the module. A green
exit code from a program that did not run is the exact failure `gate.sh` exists to catch.
The entry point is now a file whose only job is to run.

## Two findings to carry forward, not to fix here

- The card renders as a **refusal** card on the synthetic corpus (`not_enough_ranked`, 6
  relationships). Legible and honest, but **no real report card has been rendered yet**,
  and that card is what open question #1 puts in front of 20 people. Real-corpus render is
  a `NOTES.md` item, not a `04` criterion.
- `fake` cannot draft for a real gist, so a default run yields three gists and zero
  drafts. With `BOI_MODEL_PROVIDER=gemini` the same run yields two stance-distinct
  candidates per item, validator passed first attempt on all three. Say which provider
  produced any draft evidence you report.

## Then stop

`05` is Spectrum. **Stop before the live send** — that one needs the user's explicit
confirmation, and it texts a real human.
