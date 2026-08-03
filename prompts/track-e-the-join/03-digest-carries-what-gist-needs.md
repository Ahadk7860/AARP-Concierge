# Track E — Prompt 03: remove the seam you were told to build

**Depends on:** 01 and 02, merged or on the branch. **Read first:**
`prompts/AMENDMENT-001-digest-carries-what-gist-needs.md`. This prompt implements it and
adds nothing to it.

## Context

You found that the gist producer is on the wrong side of the process boundary, and you
were told to build `BOI_CORPUS_DB` anyway and document it. This prompt deletes it.

The amendment is the reasoning. The short version: four fields move into `digest.v1`, the
producer gains a constructor that reads them, and the corpus goes back to being a thing
only the Mac ever opens.

## Objective

`gistsFor` produces gists — including `action_needed` gists — from a digest that arrived
over HTTP, with no corpus path configured anywhere in the cloud.

## Scope

**In scope:**

- `contracts/schema/digest.v1.json`: `last_from_me`, `max_gap_days`, `unanswered_question`,
  `facts` — all **required**, `facts` shaped exactly like `gist.v1.facts`.
- `mac/Sources/BoiKit/Contracts.swift` and `DigestBuilder.swift`: emit all four.
- `intelligence/boi_intel/gist.py`: an **additive** `ThreadStats` constructor taking a
  `digest.v1` relationship. `build_gists(db_path, …)` stays exactly as it is.
- The bridge: read the digest it already fetches, build gists from it, delete
  `BOI_CORPUS_DB` / `BOI_CORPUS_DIR` and the `bridge.ts` header comment.
- Fixtures, and the leak-checker obligation below.

**Explicitly out of scope:**

- A `POST /v1/gists` route. A Swift port of the producer. Both are the post-MVP move.
- Touching `recent_inbound_text`, or adding any message prose to `digest.v1`.
- Improving the gist producer. You are moving its input, not tuning it.

## Constraints

- **Sanctioned frozen exception, this prompt only:** `contracts/schema/digest.v1.json`,
  `mac/Sources/BoiKit/Contracts.swift`, `intelligence/boi_intel/contracts.py`.
  `check-ownership.sh e` announces them rather than blocking. Everything else frozen is
  still frozen — `cloud/shared/src/contracts.ts` is **not** on this list for this prompt.
- **Paths you may modify beyond your usual ownership:** `mac/Sources/BoiKit/DigestBuilder.swift`,
  `intelligence/boi_intel/gist.py`, `intelligence/boi_intel/threads.py`,
  `scripts/check_voice_pack_leak.py`, `scripts/validate_fixtures.py`,
  `contracts/fixtures/digest/**`.
- **One commit for the whole thing.** A required field that lands without its producer
  leaves `main` red for everyone. This is the one prompt in the track where a partial
  commit is worse than a large one.

## The obligation that is easy to skip

`gist.v1.facts` is capped at 3 words and 40 characters per token, and a no-verbatim rule
is enforced on it. **The same cap and the same rule must now be enforced on
`digest.relationship.facts`.** A cap enforced in one container and not the other is not a
cap.

There is prior art on exactly this failing: the 60-character cap on `gist.facts` once let
four capitalised words through, and substring licensing let `$120` license `$12`. Read
how that was closed before writing the digest-side check, and reuse the check rather than
writing a second one that can drift.

## Definition of Done

- [ ] All four fields are present and **required** in `digest.v1.json`
- [ ] `swift test --package-path mac` passes, and a digest built from the synthetic corpus carries all four with values that match what the Python SQL producer computes from the same corpus — assert the agreement, do not eyeball it
- [ ] `boi_intel.gist` builds `ThreadStats` from a `digest.v1` relationship, and `build_gists(db_path, …)` is byte-identical to before — `git diff` that function and show it empty
- [ ] **A real `action_needed` gist is produced from a digest**, in the cloud, with no corpus path set. This is the criterion the whole amendment exists for
- [ ] `grep -rn "BOI_CORPUS" cloud/ intelligence/ .env.example` returns nothing
- [ ] The digest-side `facts` cap and no-verbatim rule are enforced by the **same** code path that enforces the gist-side one, and a fixture with a 5-word fact and one with a verbatim span each fail
- [ ] A digest missing any of the four fields is rejected at `POST /v1/digest` with `400`, not accepted-and-degraded — assert the status
- [ ] Every existing digest fixture is updated and `python3 scripts/validate_fixtures.py` exits zero
- [ ] `bash scripts/gate.sh e` green, and the frozen announcements are recorded in `NOTES.md`

## What to report

The three-pass review. For pass 1 the evidence that matters is the `action_needed` gist
produced from a digest with no corpus configured, and the empty `git diff` on
`build_gists`. Paste both.
