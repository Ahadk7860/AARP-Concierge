# Track E — Prompt 06: four things the audit found, three of them mine

**Depends on:** 04. No edge to `05` — different files entirely, so batch them.
**Read first:** `01-strategy/MVP_GAP_AUDIT.md`, findings 3, 4 and the "smaller" section.

## Context

An independent audit of the strategy documents against this repo found that every invariant
encoded in `CONTRACTS.md` is holding. The gaps are in rules that **never reached
`CONTRACTS.md`** — which means no track could have built them, and none of these is a track
defect.

## Objective

Four fixes. Each is small. Two of them are the difference between a draft that is honest
and a draft that is confidently wrong.

## 1. `as_of` never reaches the drafter, and nothing forbids present-tense claims

`BOI_ARCHITECTURE.md` § 6.6 requires *"`as_of` in every prompt, and a system instruction
forbidding present-tense claims about stale state."* § 8 calls staleness *"structurally
impossible to lose."*

`prompts.py` contains the string `as_of` **zero times**. `render_gist()` emits state,
`days_silent`, the question flag, topic and deadline — no timestamp. `SYSTEM` has five
rules and none is about tense. Searching all of `prompts/` for "present tense" returns
nothing: the rule was lost between the architecture and `CONTRACTS.md`.

**What it costs.** `days_silent` is computed at digest time. Mac closed for four days →
the model is told "3 days silent" with no anchor and no instruction to hedge → it writes
*"sorry, been 3 days"* into a message **the user sends in their own name.** `staleness.ts`
puts a caveat above the draft; a caveat above a confident draft is not a hedged draft.

- [ ] `as_of` is rendered into every drafter prompt
- [ ] `SYSTEM` gains a rule forbidding present-tense claims about state older than the
      staleness threshold
- [ ] A test drives a gist whose `as_of` is four days stale and asserts the candidates do
      not assert a bare present-tense day count. Make it fail first
- [ ] Both rules land in `CONTRACTS.md` — an append, recorded in `NOTES.md`

## 2. The gist model can be handed an empty corpus and its output accepted

AMENDMENT-001's digest path sets `recent_inbound_text=[]` always, correctly. But `main()`
still calls `select_producer()` and passes the result into `gists_from_digest`. Hand
`LocalModelGistProducer` an empty list and the only guard is length plus
`_quotes_the_corpus(text, [])` — **which returns `False` for an empty corpus by
construction**, because it iterates a corpus that is empty. Any hallucination under 140
characters is accepted, becomes `gist["gist"]`, is fed to the drafter as `situation:`, and
is shown to the user.

Latent only because no MLX backend is installed. That is precisely why testing will not
find it.

- [ ] The digest-driven path **refuses** a model producer rather than relying on a
      fabrication gate that is vacuous when the corpus is empty
- [ ] A test installs a fake model producer on the digest path and asserts it raises rather
      than producing
- [ ] `_quotes_the_corpus` returns `True` — or raises — when handed an empty corpus, so the
      vacuous-pass shape cannot recur elsewhere

## 3. US-only is one regex character, and it is a legal invariant

`signup.ts` validates `/^\+[1-9][0-9]{6,14}$/` — any country. Both documents state *"US only
at launch. GDPR grants non-users rights we structurally cannot fulfill."*

- [ ] Signup rejects a non-`+1` number with a clear message, asserted
- [ ] The constraint is config, not a literal, so launch geography is a deploy decision

## 4. `_quotes_the_corpus` and the fabrication gate, checked for the same shape elsewhere

The empty-corpus vacuity in (2) is a *pattern*: a guard that iterates a collection and
passes when the collection is empty.

- [ ] Audit every validator gate for it. Report what you find, including "nothing else"
- [ ] Anything found gets a test that fails on the vacuous input

## Constraints

- **Paths:** `intelligence/boi_intel/{prompts,gist,validator}.py` and their tests
  (AMENDMENT-001 grants), `cloud/api/src/routes/signup.ts` — **new grant, this prompt**,
  `prompts/CONTRACTS.md` (SHARED, append-only).
- Do not touch the drafter's model routing or the card.

## Definition of Done

Every checkbox above, plus `bash scripts/gate.sh e` green and each new test verified to
fail before the fix.
