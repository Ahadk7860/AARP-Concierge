# Track B — Prompt 03: Two candidates that differ in stance

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the environment from `01`. Independent of `02` and `04` — the committed fixtures
under `contracts/fixtures/gist/` and `contracts/fixtures/voice_pack/` give you both
inputs, so you do not need `02` to have landed.

The requirement that makes or breaks this: **the two drafts must differ in stance, not
phrasing.** Two paraphrases of the same sentence is a fake choice and users notice
immediately. The pairing that works is *acknowledge-and-answer* versus
*acknowledge-and-defer* — commit or buy time, which is the real decision the user has
been avoiding, and the reason they never replied.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A drafter produces a valid `draft_bundle.v1` of two stance-distinct candidates from a voice pack and a gist, through a model router that stamps model and prompt version on every draft.

## Scope

**In scope:**

- `draft(voice_pack, gist, n=2) -> DraftBundle`.
- **Prompt-cache structure from day one:** voice pack in the cached prefix, gist in the suffix, cache key `(user_id, contact_id, voice_pack_version)`. This is the whole cost story and retrofitting it means rewriting every prompt.
- Model router with adapters for `FakeProvider`, Gemini, and Kimi, all behind `ModelProvider`. Selected by `BOI_MODEL_PROVIDER`.
- `model_id` and `prompt_version` stamped on every bundle, so a regression is one query away from being attributable.
- Both candidates open by owning the silence — that is what the user actually owes.
- **Log the prompt hash, never the prompt.** A bad draft must be reproducible from `(voice_pack_version, gist_id, prompt_version, model_id)` without a prompt log full of user content in an observability vendor.

**Explicitly out of scope for this prompt:**

- The validator — that is `04`. Emit candidates; let `04` judge them.
- Choosing between models. That is `05`, on evidence.
- Sending anything, anywhere, ever.
- Drafting for group chats.
- Live calls in the unit suite. `FakeProvider` is the default; live belongs in `05`.

## Constraints

- **Paths you may modify:** `intelligence/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `draft_bundle.v1` — frozen. **Exactly two candidates or exactly zero; the two must differ in `stance`.** The frozen dataclass raises on both violations.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `python -m boi_intel.draft --voice-pack contracts/fixtures/voice_pack/maya.json --gist contracts/fixtures/gist/maya_action_needed.json` prints two candidates
- [ ] **`python3 scripts/validate_fixtures.py draft_bundle.v1 <output>` exits zero**
- [ ] The two candidates have different `stance` values — asserted, and the frozen dataclass already raises if not
- [ ] The whole unit suite passes with `BOI_MODEL_PROVIDER=fake` and **no network**: run it with networking disabled if you can, and say how you verified it
- [ ] The router selects the right adapter for each of `fake`, `gemini`, `kimi` — asserted with the live adapters mocked
- [ ] **Prompt-cache structure is real, not nominal:** a test asserts the voice pack is passed as `cached_prefix` and the gist as `suffix`, and that the cache key changes when `voice_pack_version` changes and not when the gist changes
- [ ] `model_id` and `prompt_version` are non-empty on every bundle — asserted
- [ ] **No prompt text is logged:** `grep -rn 'log.*prompt\|print.*prompt' intelligence/` shows no call that emits prompt contents, and a test asserts the log line contains the hash and not the exemplars
- [ ] One live Gemini call succeeds with `BOI_MODEL_PROVIDER=gemini BOI_ALLOW_LIVE_CALLS=1` and produces a valid bundle — paste it. This is the only live call in the track outside `05`.
- [ ] Existing tests still pass: `python -m pytest` exits zero
- [ ] Lint passes: `ruff check intelligence` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh b` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

> Use `git diff --name-only main...HEAD`, not `git status`. After the mandated commit
> `git status` is empty and the check passes silently — leaving the entire ownership
> model unguarded. `scripts/check-ownership.sh` does this correctly.

Every criterion above is checkable using **only the foundation stubs and this track's
own code.** Nothing here requires another track's real implementation.

## Self-verification — do this before reporting

1. Run every item in the Definition of Done yourself.
2. If any item fails, fix it and run the whole checklist again.
3. Repeat until every item passes, or until you are genuinely blocked in a way you
   cannot resolve within this prompt's scope.
4. Only then report.

### Frozen anchors

You may not modify, skip, delete, or weaken any existing test, assertion, lint rule,
or type constraint in order to pass this checklist. You may not lower a threshold, add
an exception, loosen a type, or mark a test pending or skipped.

If a check must change for a legitimate reason, stop. Record it in `NOTES.md` under
`## Deviations from the plan`, and report it. Do not change it and continue.

**A green checklist bought by weakening a check is a failure reported as a success.**

A fresh-context reviewer will read the full diff specifically for bent anchors when
this track completes.

Summary: **a green checklist bought by weakening a check is a failure reported as a
success.** You are grading your own work here, and the easiest way to turn a criterion
green is to weaken the criterion. A fresh-context reviewer reads the full diff for bent
anchors when this track completes.

## Evidence to include in your report

Claims are not accepted; artifacts are. Produce:

- the two candidates for the Maya fixture, verbatim
- the same for the Yu fixture
- one live Gemini bundle
- the cache-key test output
- full `pytest` output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add intelligence/
git commit -m "track-b: 03 drafter — <what changed>"
```

Commit even if the next prompt continues the same file. Every stage gets a commit.

## Stop

After committing, **stop and report.** Do not begin the next prompt.

> **Do not merge this branch. Do not open a pull request. Do not touch the base
> branch. Stop and report when the track is done.** Full rule:
> `prompts/MERGE-POLICY.md`.

If you are blocked rather than done: commit what works with the blocker named in the
message, write it into `NOTES.md` under `## Blockers`, and report. A reported blocker
is a legitimate outcome. A false green is not.

Wait for the user's go-ahead.
