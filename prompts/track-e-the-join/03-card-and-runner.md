# Track E — Prompt 03: one command, the whole pipe

**Depends on:** 01 and 02. Both.

## Context

Two things happen here, and they are one prompt because the second is how you find out
whether the first worked.

`composeBrief` accepts `card_url` and every caller passes `null`. `cloud/card/` renders a
9:16 PNG, is tested against its own archetypes, and has never been called by the brief.

And then: the runner. There is no process anywhere in this repo that goes from a synthetic
`chat.db` to a sent message. Four tracks, roughly a thousand tests, and the number of times
the product has been executed is zero.

## Objective

`npm run e2e` takes an empty database and a synthetic corpus and ends with a brief in
`StubChannel.sent` containing gists, drafts and a card — with every stage's artifact
written to a directory you can open and read.

## Scope

**In scope:**

- The card call: `compose` gets a real `card_url` from the renderer, and a renderer that is
  down produces a brief **without** a card rather than no brief.
- `cloud/e2e/`: the runner. Fresh database, migrations, signup, pairing, a real `boi --sync`
  against a synthetic `chat.db`, upload, tick, send. `StubChannel` throughout.
- An artifact directory: the digest as uploaded, the gists, the drafts, the rendered PNG,
  the composed brief, and the outbound blocks as the channel received them. One directory
  per run, timestamped.
- A seam report: for each stage, what went in, what came out, and how long it took.

**Explicitly out of scope:**

- Spectrum. `04` does that, and it does it *after* this is green. Sending a real iMessage
  from a pipe that has never run is how you find out about a bug by texting a stranger.
- Performance. Note the numbers, tune nothing.
- The scheduler's cron. Call `runForUser` directly with a controlled clock.

## Constraints

- **Paths you may modify:** `cloud/e2e/`, and **only the `card_url` argument** at the
  `composeBrief` call site in `cloud/brief/src/run.ts`.
- **Paths you must not touch:** `cloud/card/src/` — it is merged and tested; you are calling
  it, not fixing it. If it needs a change, that is a `NOTES.md` finding.
- **Contracts:** `brief.v1`, `outbound.v1` — frozen.

## What this prompt is actually for

Not the runner. The runner is a script. **This prompt exists to make the four tracks
disagree in public**, and the artifact directory is the instrument.

So: when a stage produces something the next stage did not expect, the correct action is
*not* to make it work. It is to write down precisely what disagreed, in `NOTES.md`, with
both sides quoted — and then make it work in the narrowest way available, in the bridge
rather than in either track's code.

A run that goes green on the first attempt is the outcome to be most suspicious of. Check
the artifacts by hand before believing it. Specifically: open the PNG, read the two drafts,
and confirm the gist is about the person the brief says it is about.

## Definition of Done

- [ ] `npm run e2e` exits zero from an empty database, with no manual steps
- [ ] The run writes an artifact directory containing, at minimum: `digest.json`, `gists.json`, `drafts.json`, `card.png`, `brief.json`, `outbound.json`
- [ ] `card.png` **opens and is legible.** Paste it in the report. A PNG that decodes is not the same as a card a human can read
- [ ] The brief in `StubChannel.sent` contains at most three items, each with a gist and two drafts, and a `card_url` that resolves
- [ ] The drafts are about the contact the gist names — assert `contact_id` equality across all four artifacts, not just presence
- [ ] **The renderer being down produces a brief with `card_url: null` that still sends.** Kill the card server and assert it
- [ ] Running `npm run e2e` twice against the same database sends **once** — the idempotency Track D built is exercised for the first time by a second real run, not by a unit test
- [ ] The seam report prints per-stage timings and payload sizes
- [ ] Every disagreement found between tracks is in `NOTES.md` with both sides quoted
- [ ] `npm test && npm run lint && npm run typecheck` and `swift test --package-path mac` and `python -m pytest` all exit zero
- [ ] `bash scripts/check-ownership.sh e` exits zero

## What to report

Pass 1 evidence is, unusually, mostly artifacts rather than test output: the PNG, the two
drafts, and the brief JSON. Redact the other party's message content. Then the seam report
and the `NOTES.md` diff.
