# Track B — Notes

Running log for this track. The user reads this alongside the commit history when
reviewing. Append; do not rewrite history here.

This file is how you talk to the user, since you cannot talk to the other agents.
Everything you want to say to somebody outside this worktree goes here.

## Blockers

Anything that stopped progress. For each: what you were doing, what you expected, what
happened, what you tried, and whether it is still open.

Format: `[prompt NN] <OPEN | RESOLVED> — <what and what you tried>`

- `[prompt 01] RESOLVED` — no Python 3.11+ existed on this machine (system Python is
  3.9.6; `pyproject.toml` requires `>=3.11`), so the venv could not be created and
  nothing in the track could run. Installed `python@3.12` with Homebrew and built
  `.venv` from `/opt/homebrew/bin/python3.12`. This is a machine-level change outside
  the worktree, flagged here because the other three tracks share the machine and one
  of them may assume a different interpreter.

- `[prompt 03] RESOLVED — the live Gemini call succeeded once the user added the key.`
  Bundle pasted in the report and written to `/tmp/boi-b/out/draft_live_gemini.json`;
  it validates against `draft_bundle.v1`, passed every gate on the first attempt
  (`attempts: 1`, `failures: []`), took 1024 ms, and produced two stance-distinct
  candidates in register. **One live call was made, and only one** — the DoD's limit.
  It surfaced a new gap, below.

- `[prompt 03] OPEN — the pinned default model no longer exists for new API keys.`
  `.env.example` and CONTRACTS.md § 11 item 12 both pin `gemini-2.5-flash-lite`. With a
  fresh key that model returns:

  ```
  404 NOT_FOUND — This model models/gemini-2.5-flash-lite is no longer available to
  new users. Please update your code to use a newer model.
  ```

  It still appears in `models.list()`, so a capability check would not catch this; only
  a real request does. The live call was therefore made with
  **`gemini-3.5-flash-lite`**, passed as an environment override — `.env.example` is a
  shared file and CONTRACTS.md is frozen, so **this track changed neither**.
  For the user: the current flash-lite family is `gemini-2.0-flash-lite`,
  `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, plus the moving alias
  `gemini-flash-lite-latest`. Recommend pinning a **concrete version** rather than the
  alias — prompt 05 is a model bake-off, and an alias that moves under it makes the
  evidence unreproducible a week later. Whatever is chosen wants updating in both
  `.env.example` and § 11 item 12, and it becomes one row of 05's matrix rather than a
  decision to make now.

- `[prompt 03] CLOSED — GEMINI_API_KEY was not provisioned.` The prompt's Definition of Done asks for one live call producing a
  valid bundle, and CONTRACTS.md § 7 records the user as the party who acquires this
  key. `.env` carries `GEMINI_API_KEY=` (empty), inherited from `.env.example`.
  **This is the only red item across prompts 03 and 04.**
  How far the path was verified without it: `google-genai` is installed (the `live`
  extra), `GeminiProvider.preflight()` passes with a key present, and with a deliberately
  invalid key the adapter builds the request, reaches Google, and comes back
  `ClientError 400 INVALID_ARGUMENT — API key not valid`. So request construction,
  transport, and error propagation are all exercised; **only authentication is
  unproven.** To finish the item: put a real key in `.env` and run
  `BOI_MODEL_PROVIDER=gemini BOI_ALLOW_LIVE_CALLS=1 python -m boi_intel.draft
  --voice-pack contracts/fixtures/voice_pack/maya.json --gist
  contracts/fixtures/gist/maya_action_needed.json`. Both switches are required; either
  one alone still refuses.

- `[prompt 02] OPEN — the local gist model is not runnable in this environment.`
  Required by the prompt's evidence list, so stated plainly: **no local model was run
  and no model output exists.** `mlx_lm`, `mlx`, `llama_cpp` and `huggingface_hub` are
  all absent from this worktree's venv (the `local` extra is not installed), and no
  weights are on disk. The machine is `arm64`/Darwin, so MLX is the right backend when
  someone does install it.
  What ships regardless: `LocalModelGistProducer` implements the full interface —
  backend detection (MLX first, llama.cpp CPU fallback), `model_path()`, `download()`
  via `huggingface_hub.snapshot_download` into `/tmp/boi-b/models`, prompt
  construction, and output validation. `select_producer()` reports
  `"weights not downloaded to /tmp/boi-b/models/<id>"` and returns the SQL producer.
  **Nothing fabricates model output.** The three tests that exercise the model branch
  inject a stub backend and assert *plumbing only* — that a copied sentence is
  discarded, that an overlong answer is discarded, and that the model cannot move
  `state`, `facts`, `priority` or any other structured field. They deliberately make no
  claim about gist quality from a real model. Prompt 05's eval harness is where that
  question belongs.

## Contract gaps

Anything `prompts/CONTRACTS.md` does not specify, specifies wrongly, or specifies in a
way that does not work in practice. You may not edit it — record it here and report.
Every entry names the prompt where it surfaced.

- `[prompt 04] OPEN — two frozen artifacts contradict each other, and the prompt's
  "maya_pass passes every gate" criterion cannot be met without softening a gate.`

  `contracts/fixtures/draft_bundle/maya_pass.json` declares `validator.passed = true`.
  Implemented exactly as prompt 04 specifies, it fails **two** gates:

  | Gate | Why | Evidence |
  |---|---|---|
  | `forbidden_phrase` | the `answer` candidate contains **U+2014 EM DASH**, and the frozen `contracts.FORBIDDEN_PHRASES` lists the em dash | `"sorry been mia — yes im still coming on the 14th, book it"` |
  | `length_gate` | the `defer` candidate is **79 chars** against a limit of **2 × 34 = 68**, where 34 is `maya.json`'s own `median_len_chars` | prompt 04: "within 2× the user's median message length" |

  **It is not only the fixture.** `contracts/transcripts/model/maya_action_needed.json`
  and `yu_fading.json` are the recorded *good* model output for the FakeProvider replay,
  and **both contain an em dash too**. So under a literal reading of the frozen phrase
  list, the drafter's entire happy path degrades to zero candidates. That is visible as
  a real behaviour change: prompt 03's checklist item "the CLI prints two candidates for
  the Maya fixture" was green when 03 was committed (03 shipped structural gates only)
  and is **red now that 04 wires the real validator in**. Pinned by
  `test_draft.py::test_the_happy_path_transcripts_degrade_CONTRACT_GAP`.

  **Not worked around, and deliberately not fixed here.** Prompt 04 is explicit:
  "Softening a gate because a real draft tripped it… If a gate is wrong, that is a
  finding for `NOTES.md`, not an edit," and "extend, never shorten" the phrase list.
  Both offending artifacts are frozen and user-owned. A test asserts
  `FORBIDDEN_PHRASES ⊆ ALL_FORBIDDEN_PHRASES`, so the em dash cannot be quietly dropped
  later either.

  Resolutions available to the user — all four are one-line, and **the choice is
  yours, not a track's**:
  1. Amend the three frozen artifacts to use a comma or a hyphen instead of an em dash,
     and shorten the `defer` candidate to ≤ 68 chars. Keeps both gates strict.
  2. Remove `"—"` from `FORBIDDEN_PHRASES` in the frozen `contracts.py` and treat
     the em dash as a **register** signal instead — it is arguably closer to one, since
     whether an em dash reads as assistant-speak depends entirely on whether *that user*
     types them.
  3. Loosen the length rule to `max(2 × median, p90)`. On `maya.json` that is
     `max(68, 88) = 88` and the fixture passes. Note this is a **spec change**, not an
     implementation detail — prompt 04 says 2× median.
  4. Accept that these fixtures are illustrative rather than gate-conformant, and amend
     prompt 04's criterion.

  My read, offered as input only: the em dash entry is doing real work (it is the single
  most reliable machine tell in 2026) and the fixtures were most likely written by a
  model, which is why they contain one. Option 1 fixes the artifacts rather than the
  rule. But the 2× median limit is separately worth re-examining — see
  `## Observations`.

- `[prompt 01] RESOLVED by the foundation` — the two gaps below were both closed by
  `548d125` on `main`, merged forward into this branch. `ruff check intelligence` now
  exits zero with no suppressions, and `BOI_DEV_USER_SALT` now exists in
  `.env.example`. Both original entries are kept verbatim underneath, because the
  commit history is read against them.

- `[prompt 01] CLOSED` **`ruff check intelligence` cannot exit zero, and the cause is a
  frozen file.** Prompt 01's Definition of Done requires it. At the foundation commit
  (`d95d215`), before this track wrote a line, `ruff check intelligence` already
  reported **9 errors**: 8 in `intelligence/boi_intel/contracts.py` (1×`I001`,
  7×`UP045`) and 1 in `intelligence/tests/test_foundation.py` (`I001`). `contracts.py`
  is frozen by `scripts/check-ownership.sh` and by CONTRACTS.md § 8, so this track
  cannot fix it. Every file this track owns is lint-clean; the residue is exactly the
  pre-existing 9. Reproduce the baseline with:
  `git archive d95d215 intelligence | tar -x -C /tmp/boi-b/baseline && ruff check /tmp/boi-b/baseline/intelligence`.
  Resolutions available to the user, none of which a track may take unilaterally: run
  `ruff check --fix` on `contracts.py` on the base branch, or add a `per-file-ignores`
  entry to `pyproject.toml`. **This track deliberately did neither** — the second in
  particular is an exception added to turn a checklist green, which prompt 01 forbids.
  Deliberately left `test_foundation.py` untouched too, even though this track owns
  `intelligence/tests/`, so the reviewer sees an unambiguous "changed nothing outside
  my own new files" diff.

- `[prompt 01] CLOSED` **No `user_salt` is defined for Track B.** `voice_pack.v1.contact_id`
  must match `^h_[0-9a-f]{8,32}$` and CONTRACTS.md § 3 defines it as
  `HMAC(user_salt, normalized_handle)` computed on the Mac, with the salt issued by
  `POST /v1/pair` and stored in the Keychain (§ 7). Track B has no pairing flow and
  `.env.example` assigns no salt variable to Track B — `BOI_USER_SALT_PEPPER` belongs
  to Track D and is a different thing. See `## Runtime resources` for what was used.

- `[prompt 04] OPEN — a retention-capped corpus silently undercounts the `revived`
  state, and `classify()` cannot tell.` Second-order effect of Track A's
  `first_contact_at` finding (CONTRACTS.md, 2 Aug): on a corpus capped by *Keep
  Messages = 1 Year*, `threads.max_gap_days` can only ever observe gaps **inside** the
  window. `classify()` requires `max_gap_days >= 90` to return `revived`, so a
  friendship that genuinely went quiet for two years and came back reads as an ordinary
  active thread — the reunion, which is the most emotionally significant state the
  product has, is invisible. A thread dormant for longer than the retention window is
  likewise absent entirely rather than `dormant`.
  What Track B would need to fix it: `corpus.retention_boundary` surfaced alongside the
  thread statistics, plus a rule that `max_gap_days` is **unknown** rather than small
  when a thread's earliest message sits within a day of the boundary. Track A already
  computes that boundary for `first_contact_at`, so the value exists; it is the plumbing
  to Track B that does not. Windowed statistics — `days_silent`, momentum, the 90-day
  comparison — are unaffected, and `gist.v1` has no `first_contact_at`, so nothing Track
  B *emits* is currently wrong. This is a missed signal, not a false claim.
  **Not reproducible on the synthetic fixture, and stated as reasoning rather than as a
  measurement.** Checked with the new `--retention-cap-days 365` flag: `max_gap_days`
  per thread is `[11, 0, 0, 0, 0, 1]` uncapped and `[11, 0, 0, 0, 0, 0]` capped, because
  `make_synthetic_chatdb.py` spreads each thread's messages evenly over its range and so
  never produces a gap anywhere near the 90-day `revived` trigger. Neither variant can
  reach the state, so the fixture cannot show the difference either way. The claim rests
  on Track A's real-corpus finding (every `first_contact_at` floored at an exact 365-day
  boundary) plus the arithmetic of `classify()`, not on anything demonstrated here.

- `[prompt 05] OPEN — the fabrication gate refuses a real human message, and the eval
  harness is what found it.` The `oracle` row replays the user's own reply through the
  full pipeline, so its validator pass rate measures how often the gates would refuse
  something the user actually sent. It comes out at **95% — 19 of 20**. The one refusal:

  ```
  reply : "sorry been mia this week, work has been insane"
  gate  : fabrication_gate
  reason: "this week" was extracted as a date and is not in gist.facts
  ```

  That is a false positive of a specific shape. The fabrication gate exists to stop an
  invented **commitment** ("yes im free thursday at 7"). `"been mia this week"` is a
  relative time expression used **descriptively about the past** — it commits to nothing
  and invents nothing. `facts.py` cannot tell the two apart because it matches
  `RELATIVE_DAYS` positionally, with no notion of tense or of whether the phrase is the
  object of a commitment.
  **Deliberately not fixed.** Prompt 05 puts it out of scope in as many words: "Any
  change to the gates in `04` to improve a score. That is scoring your own exam." A
  plausible fix is to license descriptive relative-time phrases when they refer
  backwards ("this week", "last week", "all week") while keeping forward-looking ones
  ("next week", "this weekend") gated — but that is a gate change and it belongs to
  whoever owns 04's next revision, with this eval run as the evidence.
  Worth stating plainly: **this is a 5% false-refusal floor on every model row.** No
  model can score above 95% on `pass` while the gate behaves this way, so the oracle row
  is the ceiling, not 100%.

- `[track review] OPEN — `scripts/review-capture.sh` always reports `EXIT: 0`, whether
  the command passed, failed, or never ran. Affects all four tracks.`

  The script sets `set -uo pipefail` (line 17) and then, for both the Tests and Lint
  blocks, does:

  ```bash
  eval "$TEST" 2>&1 | tail -120 || true
  echo "EXIT: ${PIPESTATUS[0]}"
  ```

  Under `pipefail` a failing command makes the whole *pipeline* fail, so `|| true`
  fires — and `true` **resets `PIPESTATUS`**. `${PIPESTATUS[0]}` is then `true`'s own
  status, which is 0. Verified A/B:

  | shell options | command | reported `EXIT:` |
  |---|---|---|
  | `-uo pipefail` (as in the script) | `sh -c 'exit 3'` | **0** |
  | `-u` (no pipefail) | `sh -c 'exit 3'` | 3 |
  | `-uo pipefail` | `sh -c 'exit 0'` | 0 |

  Without `pipefail` the pipeline's status is `tail`'s, which is 0, so `|| true` never
  fires and `PIPESTATUS[0]` survives correctly. The two features together invert it.

  **Why this matters more than a cosmetic bug:** the capture is Pass 1 of the track
  review and the whole point of it is that "every command below was re-run from this
  worktree; none of it is the working agent's claim." A reviewer reading
  `## Tests … EXIT: 0` concludes the suite passed. It would say exactly that with the
  suite entirely red. This is the same class of failure `gate.sh`'s own header warns
  about — a suite that cannot run reporting zero failures — in the script written to
  catch it. `gate.sh` gets it right (`rc=${PIPESTATUS[0]}` captured immediately, no
  `|| true`); `review-capture.sh` does not.

  I hit it for real: the first capture on this track recorded
  `python: command not found` / `EXIT: 0` and `ruff: command not found` / `EXIT: 0`,
  because the script calls bare `python`/`ruff` and this worktree's interpreter lives in
  `.venv/`. **Two defects, one visible and one not.** The committed
  `review-capture-b.md` was regenerated with `PATH="$PWD/.venv/bin:$PATH"` so its Tests
  and Lint sections show real output (307 passed, lint clean) — the pytest summary line
  in the body is trustworthy even though the `EXIT:` line is not.

  Not fixed here: `scripts/**` is foundation-owned, and a correctness change to the
  script that produces review evidence for all four tracks is the user's call. Suggested
  fix is one line each — drop `|| true` and capture the status directly, as `gate.sh`
  does. Worth also making the script fail loudly when `$TEST`'s interpreter is not on
  `PATH`, since Tracks A, C and D have the same shape of problem (`swift`, `npx`).
  **Any capture already taken for another track should be re-read for this.**

## Shared file changes

Every append to a foundation-owned shared file: dependency manifests, lint config,
`.env.example`. One line each, so the user can anticipate merge conflicts.

Format: `[prompt NN] <file> — added <what> because <why>`

- **None.** Prompt 01 added no dependency and no environment variable. Every module is
  standard library plus what the foundation manifest already pins. `git diff
  --name-only main...HEAD` touches only `intelligence/**` and this file.

## Runtime resources

Any port, database, cache directory, container name, external path, or rate-limited
credential you needed that `CONTRACTS.md` § 9 does not assign to you. Do not pick a
default — another track may pick the same one. Record it and report.

Format: `[prompt NN] needed <resource> — used <what> provisionally / blocked`

- `[prompt 01] RESOLVED — needed a user_salt for the contact_id HMAC.` Originally used
  a `--salt` flag with a provisional module constant `DEFAULT_SALT = b"boi-dev-salt"`.
  The foundation amendment added `BOI_DEV_USER_SALT` to `.env.example`, shared with
  Track A, so `DEFAULT_SALT` is **deleted**: `resolve_salt()` now takes `--salt`, else
  `$BOI_DEV_USER_SALT`, else the same key from this worktree's `.env`, and **raises if
  none is set**. There is deliberately no hardcoded fallback — a silent default is
  precisely how Tracks A and B would end up deriving different contact ids for the
  same person, surfacing as an unexplainable `--compare` diff instead of a
  missing-configuration error. Changing the salt changes every contact id, so the
  per-contact filenames in `/tmp/boi-b/out/` differ from those in the first report.
- `[prompt 01] used only assigned resources otherwise` — scratch `/tmp/boi-b`, fixture
  `/tmp/boi-b/chat.db`, output `/tmp/boi-b/out/`. No port was needed. No live model
  call was made; nothing in this prompt touches a model at all.

## Requests to other tracks

Things another track owns that you need. You cannot reach across and do it yourself.
Record it, report it, and continue with a local workaround only if the workaround is
visible and reversible.

Format: `[prompt NN] → Track <X>: <what you need and why>`

- `[prompt 01] → Track A:` the Swift voice-pack port is verified against this
  implementation with `python -m boi_intel.voice --compare <swift.json> <python.json>`,
  which reports every differing field by dotted path. Four rules are easy to
  reimplement *plausibly* and still mismatch, so they are called out explicitly:
  1. **`voice_pack_version` excludes `as_of`.** It hashes `{contact_id, scope,
     register, exemplars}` only, as canonical JSON with sorted keys,
     `separators=(",", ":")`, and `ensure_ascii=False`, then `"vp_" + sha256(...)[:8]`
     — **8 hex characters**, per the CONTRACTS.md § 6 amendment. Emoji in `top_emoji`
     are hashed as themselves, never as `\uXXXX` escapes.
  2. **Ties in `top_emoji`, `abbreviations` and `apology_openers` break on the value
     itself**, not on insertion order (`register._by_frequency`). Insertion order is
     not reproducible across two languages.
  3. **Percentiles are nearest-rank half-up, computed in integer arithmetic:**
     `(p * n + 99) // 100 - 1`, clamped to `[0, n-1]`. The § 6 formula is
     `ceil(p/100 * n) - 1`; the integer form is the same rule with no
     binary-floating-point representability case, since `p / 100` is inexact and the
     float form is one unlucky rounding from stepping to the next index in one
     language only. **The median is p50 under this same rule**, not the average of the
     two middle values — one rounding rule to agree on instead of two.
  4. **Time-bucket boundaries use `floor`, not `round`**, for the same reason
     (`voice._select_exemplars`).
  5. **Exemplar selection is redact → truncate → deduplicate → 8 contiguous time
     buckets → within each bucket walk the length distribution (shortest, longest,
     then bisection) → round-robin across buckets → re-sort chronologically.** The
     dedup runs on the **final** string, after redaction and truncation. Deterministic
     by construction; there is no sampling seed to match.
  6. **The register is computed on the RAW corpus, before any redaction**
     (CONTRACTS.md §§ 6 and 7). Redaction touches `exemplars` only.
  7. **`contact_id` uses `$BOI_DEV_USER_SALT`** from `.env`, the value § 7 fixes for
     both tracks, over the normalized handle (`chatdb.normalize_handle`: lowercase,
     strip non-digits except a leading `+`, add `+1` to a bare 10-digit number).
  Compare with `--ignore as_of` when the two runs are not simultaneous.

## Deviations from the plan

Anywhere the implementation departs from what the prompt described, and why. A
deviation is not a failure — an unrecorded one is.

- `[prompt 01]` The prompt specifies `--compare <other.json>`, which names one file and
  leaves the other implicit. Implemented **both** readings rather than guessing:
  `--compare A B` takes two paths, and `--pack A --compare B` matches the prompt's
  literal single-argument form. Both are exercised in the test suite.
- `[prompt 01]` Exemplars are **deduplicated** before sampling. The prompt says "up to
  40 exemplars ... sampled across the time range and across lengths" and does not
  mention dedup. Without it the synthetic corpus — 10 distinct sent lines repeated
  thousands of times — yields 40 near-identical exemplars, which teaches a drafter
  nothing and makes the content hash flip on any single new message. This is why the
  synthetic packs carry 10 exemplars rather than 40; a real corpus will fill all 40.
- `[prompt 01]` Messages longer than 200 characters are **truncated on a word
  boundary** rather than dropped, so a long-form writer still gets exemplars. The
  register statistics are computed on the **full untruncated** redacted corpus, so
  truncation cannot bias `median_len_chars` or `p90_len_chars`.
- `[prompt 01]` The two exemplar caps are enforced with `raise ValueError`, not
  `assert`. `python -O` strips `assert`, and a cap that silently disappears under an
  optimisation flag is not a cap.

### Prompt 01 correction, after the CONTRACTS.md §§ 6 and 7 amendment

Five defects the amendment named, all fixed in the follow-up commit. Each one is now
covered by a test that was **verified to bite** by reverting the fix and watching the
test fail (runs are in the report):

1. **The register was computed on the redacted corpus.** This was the real bug — a
   sentence-case writer who opens with a name was reported as `lowercase_no_period`
   with a greeting rate of zero, and every register test passed anyway. `_serialize`
   now calls `compute_register` on raw `m.text` and redacts only the exemplar strings.
2. **`FULL_NAME` required `[A-Z]`**, so `"ill ask john smith about it"` was untouched
   in a corpus whose own register is `lowercase_no_period`. Added a lowercase path:
   a known given name followed by a token that is not a common English word. Given
   names that are also ordinary words (`will`, `may`, `mark`, `grant`, `hope`, `rose`,
   …) are deliberately excluded from the list so `"i will call you"` survives intact.
3. **Dedup ran before truncation and redaction**, so forty exemplars could be twenty-one
   unique strings. The pipeline is now redact → truncate → dedup → sample, and dedup
   sees the final string.
4. **`_percentile` used `round()`** (banker's). Now nearest-rank half-up in integer
   arithmetic, and the median is p50 under the same rule. Bucket boundaries in
   `_select_exemplars` moved from `round()` to `floor()` for the same reason.
5. **The hash was `[:12]`.** Now `[:8]`, as § 6 pins. `ensure_ascii=False` was already
   correct and is now covered by a test that fails if it ever flips.

### Prompt 02 — gists

- `[prompt 02]` **`display` is deliberately omitted from every gist.** `gist.v1` allows
  it and the fixtures carry `"Maya"`, but the only name Track B can see is the raw
  handle out of `chat.db`, and CONTRACTS.md § 3 says the server must never receive a raw
  handle for anyone but the account holder. Putting `+15550100001` in `display` would
  push a raw handle into a cloud-bound document through a field meant for a friendly
  name. Real display names live in Contacts.app, which is Track A's to read — see
  `## Requests to other tracks`. A test asserts no raw handle appears anywhere in a gist.
- `[prompt 02]` **`classify()` returns `None` for a healthy thread and that thread gets
  no gist at all.** The prompt implies one gist per thread; emitting one for everybody
  would force a state onto people who are perfectly fine, and "fading" about someone you
  texted yesterday is exactly the confident wrong answer § 6 forbids. Consequence worth
  knowing: `--top 5` can legitimately write fewer than five files. On the fixture
  database it writes four of six.
- `[prompt 02]` **`birthday` is never produced.** It needs a birth date, which lives in
  Contacts.app. Inferring one from message text would be fabrication. A test pins this
  across the whole parameter space so nobody "fixes" it later by guessing.
- `[prompt 02]` **Facts are extracted from the *pending* inbound run** — the messages
  since the user last wrote — not from all inbound history. That run is literally "what
  you owe", so it is the right scope for an allowlist. Reading the whole history swept
  up a date from a year earlier and presented it as live.
- `[prompt 02]` **`has_deadline` is gated on recency** (`DEADLINE_MAX_DAYS_SILENT = 30`)
  even though the date stays in `facts`. The drafter may still mention it; the brief
  must not sort or phrase on a deadline from 300 days ago.
- `[prompt 02]` **NULL-text rows count for timing and volume, and are invisible to text
  analysis.** They are ~47% of a real corpus (§ 10). Excluding them from timing would
  report a live thread as quiet.
- `[prompt 02]` **The local model rewrites the 140-character sentence and nothing
  else.** State, `days_silent`, `facts` and `priority` stay arithmetic, so a confused
  model cannot invent a deadline or move somebody up the brief. Model output is
  discarded if it is empty, over-length, or quotes six consecutive words from an inbound
  message — and a discarded answer reverts `producer` to `"sql"` rather than claiming to
  be a model gist.
- `[prompt 02]` **Reciprocity is absent from `priority` by construction**, per § 6.
  Scoring uses waiting/unanswered/recency/volume/momentum only.

### Prompt 03 — drafter

- `[prompt 03]` **The gist id is rendered into the suffix.** `providers/fake.py` replays
  on `match.gist_id_contains` being present in the suffix, so without it every fixture
  draft raises `LookupError`. It doubles as the reproducibility handle in the log.
- `[prompt 03]` **`draft()` takes a `validate` callable, defaulting to `None`.** Prompt
  04 fills that seam. What ships here is only the structural gates the drafter cannot
  avoid — two candidates, non-empty, within `maxLength`, stances distinct — expressed in
  the frozen `VALIDATOR_FAILURES` vocabulary so 04 extends rather than replaces them.
  `validator.passed` on a bundle produced by 03 alone therefore means *structurally*
  valid, not *semantically* validated. A test asserts the seam is called and can reject.
- `[prompt 03]` **The unit suite cannot open a socket.** `conftest.py` has an autouse
  fixture that replaces `socket.socket.connect`/`connect_ex` with a raise, and a test
  asserts the guard is armed. "No network" is now a property rather than a claim. It
  binds in-process sockets only; the suite's subprocess calls are to
  `validate_fixtures.py` and `check_voice_pack_leak.py`, which read local files.
- `[prompt 03]` **An unknown `BOI_MODEL_PROVIDER` raises instead of falling back to
  `fake`.** A typo that silently yields `FakeProvider` would make an eval run in 05
  report recorded transcripts as if they were live model output.
- `[prompt 03]` **`boi_intel/env.py` is new**, and `voice._from_dotenv` now delegates to
  it. Providers read `GEMINI_API_KEY`/`KIMI_API_KEY`/`BOI_ALLOW_LIVE_CALLS` through it,
  so a key in `.env` works without exporting anything. Real environment variables still
  win over the file. `voice._from_dotenv` kept its name because a test patches it.
- `[prompt 03]` **Both live adapters require two independent switches** —
  `BOI_MODEL_PROVIDER` *and* `BOI_ALLOW_LIVE_CALLS=1` — plus a key, and `preflight()` is
  separate from `complete()` so 05 can check a whole matrix without sending anything.

### Prompt 01 correction #2 — redaction scope (CONTRACTS.md § 7 amendment, 2 Aug)

The amendment ("redaction covers every free-text field in the pack, not just
`exemplars`") landed on `main` during prompt 04 and was merged forward. Re-running
prompt 01's Definition of Done against it, per `WORKTREE-PROTOCOL.md`, surfaced **two
real leaks** — the second was latent and had nothing to do with the amendment:

1. **`register.apology_openers` carried un-redacted text.** `"sorry john smith
   cancelled on us"` produced the opener `"sorry john smith"`, so a pack with spotless
   exemplars shipped a third-party name into storage through that array — exactly what
   the amendment describes. Fixed by redacting the opener strings **after** the
   statistics are computed, which keeps both rules: § 6 requires rates off raw text, § 7
   requires emitted strings redacted. `abbreviations` (closed list) and `top_emoji`
   (emoji only) are structurally incapable of carrying a specific, and a test asserts
   all three fields stay clean.

2. **The lowercase name redactor missed names depending on their word offset.** This is
   the more serious one and it was in `exemplars` too, since the same function does
   both. `re.sub` scans non-overlapping: given `"sorry john smith"` it matched the pair
   `"sorry john"` first, returned it unchanged because `sorry` is not a given name, and
   resumed *after* `john` — so `"john smith"` was never tested. Whether a name leaked
   therefore depended on its **parity** in the sentence: `"ill ask john smith about it"`
   was redacted and `"sorry john smith cancelled"` was not. Every test written for the
   first correction happened to use an even offset, so all of them passed. Fixed by
   enumerating adjacent word pairs explicitly instead of using `re.sub`; a
   parametrised test now places the same name at six different offsets, and it fails at
   three of them against the old implementation.

Both fixes verified to bite by reverting them and watching the new tests fail.

### Prompt 05 — eval harness

- `[prompt 05]` **`oracle` is an added matrix row.** It replays the user's real reply
  through the whole pipeline. Two jobs: its register-match must come out at 1.0, which
  is the metric checking itself (if comparing a message to itself does not score 1.0 the
  metric is broken); and its validator pass rate is the **ceiling** every model row is
  measured against, because it says how often the gates refuse a real human message.
  It is not in the router — it is an eval instrument, not a production provider, and
  adding it to the router would let a typo select it in production.
- `[prompt 05]` **`fake` answers nothing, and that is reported not hidden.**
  `FakeProvider` replays four recordings keyed to fixture `gist_id`s, so on
  corpus-derived cases it matches none of them: 20 cases, 0 answered, 20
  `no_recording`. It is a determinism and no-network control, **not a quality
  baseline**, and the table says so. Re-running it produces byte-identical numbers.
- `[prompt 05]` **Latency is measured closest to the wire** (`Timed`, wrapped *inside*
  the throttle). Measuring the outer wrapper folded this harness's own rate-limit
  sleeping into `p50_latency_ms` and reported a 700 ms model as 7,524 ms — a number
  about our pacing masquerading as a number about the model, in the table that picks the
  model. Caught by looking at the first live table, not by a test.
- `[prompt 05]` **Rate limiting is handled in the harness, not in `GeminiProvider`.**
  The free tier is 15 requests/min/model and the first live matrix run returned
  `SKIPPED — 429` for both Gemini rows, which would have settled a bake-off on request
  pacing. `Throttled` paces at `--rpm` and retries a 429, preferring the API's own
  "Please retry in 996ms" hint over a guessed backoff. It is deliberately *not* in the
  provider: a production drafter that silently retries is hiding a capacity problem from
  the morning brief.
- `[prompt 05]` **`--max-calls` is enforced at the only place a call can happen**
  (`CallCapped`), and a test asserts the inner provider is never reached past the cap —
  not merely that the counter stopped.
- `[prompt 05]` **Prices carry a `source` field.** `gemini-3.1-flash-lite` is
  user-provided; `gemini-3.5-flash-lite` is **assumed identical and labelled as such**
  in the table output. An unsourced price silently becomes a fact, and this table feeds
  a spend decision.
- `[prompt 05]` **Cases come from the pending inbound run the user actually answered**,
  with a 30-day cap on reply lag: a reply three months later is a new conversation and
  scoring a draft against it measures nothing. Threads are capped at 4 cases each so one
  chatty relationship cannot dominate.

### Prompt 04 correction — the contract gap closed, and the live call landed

Both halves of the frozen-artifact conflict were resolved upstream while this batch was
in flight (`7a13857`), and the branch merged it forward:

- The em dash was removed from `maya_pass.json` and from both reference transcripts.
- The length gate was respecified in CONTRACTS.md as
  `max(median_len_chars * avg_msgs_per_burst, p90_len_chars) + 30`, replacing
  "within 2× the median". For the Maya pack that is `max(78.2, 88) + 30 = 118`.

Applied here:

- `validator.length_limit()` implements the new formula; `LENGTH_MULTIPLE` is gone and
  `APOLOGY_OPENER_ALLOWANCE = 30` replaces it. **This supersedes prompt 04's literal
  checklist wording** ("a draft at 2.1× the register median is rejected; one at 1.9×
  passes") — under the amended rule both of those pass, because the tell was never 2×.
  The replacement tests assert the limit is exactly 118 for the Maya pack, that one
  character over fails, that the 300-character paragraph the gate exists to catch still
  fails by a wide margin, and that a burstier writer gets a larger allowance.
- The three `CONTRACT_GAP` tests were **deleted**, which is what they were written to
  prompt. Two replacements took their place: `maya_pass` now passes every gate, and a
  guard asserts no reference artifact carries an em dash again.
- Prompt 03's three tests that had been isolated with `validate=None` are back to
  running the **full** pipeline through every gate, which is what prompt 03 asked for.
  The CLI prints two candidates again.

### Prompt 04 — validator

- `[prompt 04]` **Extended the forbidden-phrase list by 24 entries**, never shortened
  it. A test asserts `FORBIDDEN_PHRASES ⊆ ALL_FORBIDDEN_PHRASES`, and another asserts
  every single entry — frozen and added — actually causes a rejection, so nothing in the
  list is decorative. Added: `hope you're doing well` / `hope you are doing well` /
  `hope all is well` / `hope this message finds you`, `following up on`, `per my last`,
  `i wanted to reach out` / `wanted to reach out`, `happy to help`,
  `let me know if you have any questions`, `thank you for your patience` /
  `thanks for your patience`, `looking forward to hearing from you`, `as discussed`,
  `kind regards`, `sincerely,`, `regards,`, `i apologize for any inconvenience` /
  `apologies for any inconvenience`, `please do not hesitate`,
  `don't hesitate to reach out`, `i trust this`, `noted with thanks`, `as per`.
  **Deliberately NOT added** despite being tempting: `feel free to`, `in the meantime`,
  `no worries at all`, `cheers`. Real people text those. Over-blocking does not produce
  a safer draft, it produces zero drafts, and zero drafts every morning is a dead
  product rather than a careful one. A test pins those five as *not* flagged.
- `[prompt 04]` **The fabrication gate reuses `facts.extract_facts`** to scan the draft,
  rather than a second pattern set. Two different extractors would guarantee
  disagreement — the gist licenses "the 14th" and the gate objects to "14th". Matching
  is containment in both directions for the same reason.
- `[prompt 04]` **The retry names the failures.** `prompts.retry_note()` appends a
  correction listing what was rejected, and a test asserts attempt 2's suffix carries it
  and attempt 1's does not. A blind retry at temperature 0.9 is a coin flip.
- `[prompt 04]` **`draft(validate=...)` now defaults to the real validator.** Passing
  `validate=None` runs structural gates only; three prompt-03 tests use it to isolate
  drafter mechanics from the semantic gates, which is documented in their docstrings.
- `[prompt 04]` **The validator only ever refuses — it never rewrites.** Scope says so,
  and it also keeps the gates auditable: a rewriting validator would make "why did this
  draft ship" unanswerable.
- `[prompt 04]` `explain()` carries candidate text and is a **developer/CLI tool only**.
  It must never become a log line; `draft.py`'s `_log` remains hashes and identifiers.

## Decisions made

Choices the prompt left open that you had to resolve: a library, a data structure, an
error-handling approach. The user needs to see these before merge, because another
track may have chosen differently.

- **`mode=ro`, never `immutable=1`** (`chatdb.connect`). CONTRACTS.md § 10 documents the
  1-row difference on the fixture database; `immutable=1` skips the WAL, silently
  freezes the corpus, and raises no error.
- **Group chats (`chat.style = 43`) produce no per-contact pack**, because a group
  thread cannot be attributed to one person. The user's own words in a group *do* feed
  the global fallback — it is still their voice.
- **Tapbacks are excluded** (`associated_message_type = 0`). "Loved “…”" is not prose
  and would drag every length statistic toward zero.
- **The register is computed over the whole sent corpus, the exemplars are a sample of
  it.** Sampling both would make the statistics noisy for no benefit.
- **Redaction replaces with `[phone]`/`[email]`/`[address]`/`[amount]`/`[name]` rather
  than deleting**, so sentence shape — and therefore the register — survives.
- **Third-party names are matched conservatively**: two or more consecutive capitalised
  words, minus a small allowlist ("Thank You", "Happy Birthday", …). A single
  capitalised word is far more often a sentence opener than an identity, and redacting
  every one of them would destroy the `punctuation` signal the pack exists to carry.
- **`abbreviations` uses a closed list**, not an open "short token" heuristic, which
  would report typos and proper nouns as style.
- **A contact needs ≥ 5 sent messages** (`MIN_SENT_FOR_CONTACT_PACK`) — thin contacts
  fall back to global. A wrong voice is worse than a generic one.
- **The serializer raises rather than filtering** when a non-user row reaches it.
  Silently dropping the row would leave the broken query in place and the next build
  would leak.

- `[prompt 02] → Track A:` **display names.** Gists ship without `display` because
  Track B can only see raw handles. Track A reads Contacts.app, so the mapping
  `contact_id -> display` belongs there. Track D embeds gists in `brief.v1`, so
  whichever of you fills the field, please fill it from Contacts and not from the
  handle.
- `[prompt 02] → Track A:` **thread triage is shared logic.** `threads.py` computes
  `days_silent`, `last_from_me`, `unanswered_question`, reply latency, max gap and
  90-day momentum from `chat.db`, and `digest.v1` needs the same numbers. Worth diffing
  our two implementations before merge — the tapback exclusion
  (`associated_message_type = 0`) and the NULL-text handling are both easy to get
  silently wrong, and they move every statistic.

## Observations

Anything you noticed that the plan did not anticipate, including work that should exist
but is not in any track's scope. This is often the most useful section at review time.

- **`[prompt 05]` The newer model is the worse model here, and the failure mode says
  why.** `gemini-3.5-flash-lite` scored 70% validator pass against
  `gemini-3.1-flash-lite`'s 100%, at the same price, and **every one of its six failures
  was `fabrication_gate`** — it invents dates and times that `gist.facts` does not
  license. That is the highest-severity failure mode in the system, not a stylistic
  quibble. Across three runs 3.5 scored 60/70/75% and 3.1 scored 95/100%, so the gap is
  consistent rather than one unlucky sample, but **n=20 on synthetic data is not enough
  to be certain** — see the caveat below.
- **`[prompt 05]` The eval corpus is synthetic and that bounds every number in the
  table.** `make_synthetic_chatdb.py` draws sent messages from ten fixed lines, so the
  voice packs are 4–10 exemplars of near-identical register and the "real reply" the
  drafter is scored against is one of those ten strings. Register match at 100% for both
  models is partly the corpus being easy. The harness is corpus-agnostic — pointing it
  at a real `chat.db` needs no code change — and the numbers should be re-read before
  they decide anything permanent. **What would change the recommendation:** a real-corpus
  run, or 3.5's fabrication rate dropping once the gate's `"this week"` false positive is
  fixed.
- **`[prompt 05]` The 50-pair held-out set is not implemented; the 20-pair review file
  is.** The scope lists both a "held-out set of 50 pairs for human preference" and the
  20-pair send/edit/delete export. Only 20 usable pairs exist on this corpus — the whole
  synthetic database yields 24 eval cases total — so a 50-pair held-out split would be
  fabricated padding. `HELD_OUT_PAIRS = 50` is defined and `--review-pairs` is
  parameterised, so both are one flag away on a real corpus. Recorded here rather than
  quietly delivering 20 and calling it 50.

- **`[prompt 04]` The 2× median length gate may be too tight, and the project's own
  reference drafts are the evidence.** With `maya.json`'s median of 34 the limit is 68
  characters. Of the four recorded "good" candidates across `maya_action_needed.json`
  and `yu_fading.json`, **two exceed it** (79 and 68... the 79 fails, and `yu`'s defer is
  68 exactly). A gate that rejects half of the project's own hand-picked good output is
  worth a second look before launch. Two things make this suspicious rather than merely
  strict: the median is computed over *all* sent messages including one-word replies
  like "ok", which drags it far below the length of a considered reply; and an apology
  opener ("sorry been mia, been slammed.") costs ~30 characters before the actual answer
  starts. A rule like `max(2 × median, p90)` or `2 × median + apology_opener_length`
  would track intent better. **Not changed** — prompt 04 specifies 2× median and
  changing it is a spec decision, not an implementation one.
- **`[prompt 04]` The fabrication gate's recall is bounded by `facts.py`.** It can only
  object to a specific it can *recognise*, so a fabricated place or name outside those
  patterns passes silently. This is the highest-severity gate in the system and its
  false-negative rate is entirely a function of an extractor tuned against synthetic
  data. Before launch it deserves an adversarial pass with real drafts — the eval
  harness in 05 is the natural place.
- **`[prompt 03]` `contracts/fixtures/draft_bundle/maya_pass.json` has `chars` off by one
  on both candidates.** Declared 56 and 78; the actual `len(text)` is 57 and 79. The
  schema only requires `chars >= 1`, so `validate_fixtures.py` passes it. This
  implementation always sets `chars = len(text)` and a test asserts it. Flagging because
  Track D embeds `draft_bundle.v1` in `brief.v1` and may well use `chars` for layout —
  if it does, it will be one character out on every fixture-derived draft. The fixture
  is frozen so this track did not touch it.
- **`[prompt 03]` My own first version of the cache-key test did not bite**, and I only
  found out by trying to break it. It asserted against the pure `cache_key()` helper,
  which proves the helper is correct and says nothing about what `draft()` feeds it —
  so mixing the gist into the key inside the drafter passed the whole suite. The test
  now reads the key back off the drafter's own log line. Worth stating plainly because
  the prompt warned about exactly this ("prompt-cache structure is real, not nominal")
  and I still wrote the nominal version first.
- **`[prompt 02]` The worst bug in this prompt was over-population, not
  under-population.** `re.IGNORECASE` was being applied to the capitalised-name and
  place patterns, which turns `[A-Z][a-z]{1,20}` into "any word" — so `facts.names`
  filled up with things like `"you ever hear back about"` and `facts.places` with
  `"all\nlmk what you"`, a splice of two different messages. That is inbound prose
  travelling to the cloud inside the very object designed to prevent it, and the schema
  validated it happily because the strings were under 60 characters. Two structural
  fixes now stop the whole class: patterns are scanned **per message** (never a joined
  blob, and `[^\S\n]` instead of `\s`), and `_is_a_token` rejects anything over
  `MAX_FACT_WORDS`. Worth knowing at review time: **`facts` is the object most likely to
  leak, and a schema check will not catch it.**
- **`[prompt 02]` `facts` under-populates on the fixture database**, and that is the
  fixture's fault rather than the extractor's. `THEIR_LINES` in
  `make_synthetic_chatdb.py` has one date-bearing sentence, so most pending runs contain
  no specifics and the honest answer is five empty lists. Extraction is exercised
  properly by purpose-built inputs in `test_facts.py`. Nobody should read the fixture
  gists as evidence that facts extraction works — read the tests.
- **`[prompt 02]` `topic` and the name list are closed vocabularies and will need real
  data.** `infer_topic` recognises six categories by keyword; anything else is `None`.
  That is the safe direction (a missing label beats a wrong one) but it is a
  recall/precision dial nobody has tuned against a real corpus yet.
- **`[prompt 02]` Nothing here re-checks that `facts` covers what a draft wants to
  say.** The gate is only as good as the allowlist, so if prompt 03's drafts come back
  vague, suspect this file before suspecting the model.
- **`[prompt 01, correction]` The name allowlist is now a correctness surface.**
  Lowercase name redaction fires on a closed list of ~700 given names. A name outside
  the list leaks; a surname that happens to be a common English word is kept. This is
  a deliberately conservative trade — over-redacting destroys the `punctuation` and
  `greeting_rate` signals the pack exists to carry — but it is a recall/precision dial
  someone should look at with real data, not a solved problem. A lone first name
  (`"ill ask john about it"`) is also still untouched, because CONTRACTS.md § 7 says
  *full* names.
- **`scripts/check_voice_pack_leak.py` cannot detect a leak that redaction rewrote.**
  *(Adopted into CONTRACTS.md § 7 by the amendment — "What guard three does and does
  not do" now states this in the contract itself. Kept here for history.)*
  It classifies an exemplar as leaked only when the text is found verbatim in the
  inbound half and not in the sent half; anything matching neither is reported as
  "redacted beyond verbatim match" and passes. So an inbound message containing a phone
  number would be redacted to `[phone]`, match nothing, and sail through guard three.
  Guards one and two still stop it, and the script is frozen so this track did not
  touch it — but the third guard is weaker than CONTRACTS.md § 7 implies, and the gap
  widens as redaction gets more aggressive. Worth the user's attention before launch.
- **`voice_pack.v1` does not require `n_exemplars`**, and does not require it to equal
  `len(exemplars)`. This implementation always sets it correctly and asserts the
  equality in tests, but a Swift port could omit it and still validate. Cheap to tighten
  in the schema if the user wants it.
- **The synthetic corpus cannot exercise register detection.** All 10 sent lines are
  lowercase, none contains `?` or an emoji, and they are spread hours apart — so on the
  fixture database `emoji_rate`, `question_rate`, `greeting_rate` and `signoff_rate` are
  all `0.0` and `avg_msgs_per_burst` is exactly `1.0`. Those code paths are covered by
  purpose-built test databases instead. Nobody should read the fixture packs as evidence
  that register detection works; read the tests.
- **`question_rate` counts `?` only.** "wondering if you're around" is a question with no
  question mark, and this corpus is full of that shape. Deliberately left literal here —
  it is a register statistic, not comprehension — but prompt 03's drafter may want more.
- **`pip install -e` leaves `intelligence/boi_intelligence.egg-info/` untracked**, and
  `.gitignore` does not cover `*.egg-info/`. Left it uncommitted and did **not** append
  the pattern, because `.gitignore` is shared and all four tracks would be appending to
  it at once. Every track that runs `pip install -e` will see the same untracked
  directory. One line on the base branch fixes it for everyone.
- **The exemplar cap interacts with dedup in a way the plan did not anticipate.** For a
  user with a genuinely repetitive corpus, dedup can leave fewer than 40 unique
  candidates, so packs will be smaller than the cap. That is the correct outcome, but it
  means "40 exemplars" is a ceiling, never a guarantee, and prompt 03 should not assume
  a full pack.
