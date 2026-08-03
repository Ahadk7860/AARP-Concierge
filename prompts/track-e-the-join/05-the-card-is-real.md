# Track E — Prompt 05: the card has never existed

**Depends on:** 04. **Read first:** `01-strategy/MVP_GAP_AUDIT.md`, finding 2.

## Context

Both strategy documents name one stop condition for the entire product: show the card to
20 people, and they either screenshot it or they close it. Everything else is downstream
of that answer.

**This repo has never produced the artifact that test requires.** The synthetic corpus
yields six ranked relationships, below the renderer's bar, so every card ever rendered here
is `kind: refusal` (`not_enough_ranked`). And the URL that reaches the channel is
`file:///…/card.png` — searching `cloud/card` and `cloud/brief` for S3, blob, `putObject`
or even `writeFile` returns nothing outside the e2e runner. No transport can fetch that.

So the card is unhosted, and the only card is a refusal. Three components — renderer,
composer, channel — each correct about its own half.

You also found the third piece yourself: `deliver.ts` cannot tell a refusal card from a
report card and now sends both, so a user below the bar is handed *"not enough history
yet"* every morning, indefinitely. You were right that it is a `brief.v1` question.

## Objective

A real report card, rendered from a real corpus, reachable at a URL a transport can fetch,
deletable when the user deletes — and never sent when it is a refusal.

## Scope

**In scope:**

- **A corpus that clears the bar.** Extend `scripts/make_synthetic_chatdb.py` so a run
  produces enough ranked relationships for a `kind: standard` card. This is a fixture
  change and it is the thing blocking the kill test.
- **`card_kind` in `brief.v1`,** alongside `card_url`. The renderer already knows — it
  emits `x-boi-card-kind` — and `card-client.ts` drops it. Carry it, and let the composer
  decide.
- **Hosting.** A fetchable, authenticated URL. `file://` is not a URL a phone can open.
- **Deletion, in this prompt, not a later one.** `repository.ts` still carries *"`briefs.card_url`
  is derived data and nothing here reaches it. Prompt 04 owns that"* — and prompt 04 wired
  the card in without closing it. It is harmless today only because nothing is stored. **The
  moment hosting lands it is live**, which is why the two ship together.

**Explicitly out of scope:**

- Redesigning the card. `cloud/card/` renders well; you are giving it real input.
- Spectrum. Still last.
- Deciding *whether* a refusal card should ever be sent. Make it possible not to send one;
  the policy is the user's, recorded below.

## Constraints

- **Paths:** `cloud/card/`, `cloud/e2e/`, `scripts/make_synthetic_chatdb.py`,
  `cloud/brief/src/{compose,deliver}.ts`, `cloud/db/src/repository.ts`, plus
  `contracts/schema/brief.v1.json` — **sanctioned frozen, this prompt only.**
- The `card_kind` addition is a widening. Nothing that validates today may stop validating.

## The policy decision, already made

**A refusal card is never attached to a brief.** A brief for a user below the bar ships its
text and no image. The refusal card remains a valid artifact for the onboarding surface,
where "not enough history yet" is information and arrives once — not a reproach that
arrives every morning. Implement that; do not re-open it.

## Definition of Done

- [ ] A run against the extended corpus renders a **`kind: standard`** card. **Paste it.**
      This is the first real report card this project has produced
- [ ] `brief.v1` carries `card_kind`; the composer reads it; **a refusal card yields a brief
      with no image block** — assert over the blocks the channel received
- [ ] The card is reachable over HTTP by something that is not this process, with auth, and
      the URL in `brief.card_url` is that URL — assert a fetch, not a file read
- [ ] `deleteUser` removes the stored card, and the self-verification proves it: after
      deletion the URL returns 404 and no row references it. **A residue check that only
      walks Postgres does not satisfy this line**
- [ ] Renderer down still yields `card_url: null` and a brief that sends (already asserted
      in `04` — keep it green)
- [ ] `npm run e2e` green; `bash scripts/gate.sh e` green
- [ ] `scripts/check_voice_pack_leak.py` still clean — the richer corpus is more text, and
      more text is more chances to leak

## What to report

The card. Everything else in this prompt is in service of one PNG that a human would
screenshot.
