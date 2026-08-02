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

## Contract gaps

Anything `prompts/CONTRACTS.md` does not specify, specifies wrongly, or specifies in a
way that does not work in practice. You may not edit it — record it here and report.
Every entry names the prompt where it surfaced.

- `[prompt 01]` **`ruff check intelligence` cannot exit zero, and the cause is a frozen
  file.** Prompt 01's Definition of Done requires it. At the foundation commit
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

- `[prompt 01]` **No `user_salt` is defined for Track B.** `voice_pack.v1.contact_id`
  must match `^h_[0-9a-f]{8,32}$` and CONTRACTS.md § 3 defines it as
  `HMAC(user_salt, normalized_handle)` computed on the Mac, with the salt issued by
  `POST /v1/pair` and stored in the Keychain (§ 7). Track B has no pairing flow and
  `.env.example` assigns no salt variable to Track B — `BOI_USER_SALT_PEPPER` belongs
  to Track D and is a different thing. See `## Runtime resources` for what was used.

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

- `[prompt 01] needed a user_salt for the contact_id HMAC` — used a `--salt` CLI flag
  with the module constant `DEFAULT_SALT = b"boi-dev-salt"` **provisionally**. Chose a
  CLI flag over an env var specifically to avoid appending a name to `.env.example`
  that Track A or Track D might later define differently. Nothing depends on the value:
  contact ids are opaque, and Track A's Swift port will pass the real Keychain salt.
  If the user prefers a named variable, that is a one-line change here plus an append
  to `.env.example`.
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
     register, exemplars}` only, as canonical JSON with sorted keys and
     `separators=(",", ":")`, then `"vp_" + sha256(...)[:12]`. Including `as_of` would
     change the version every morning and invalidate the drafter's prompt cache daily.
  2. **Ties in `top_emoji`, `abbreviations` and `apology_openers` break on the value
     itself**, not on insertion order (`register._by_frequency`). Insertion order is
     not reproducible across two languages.
  3. **Percentiles are nearest-rank with no interpolation**, and the median of an even
     count is integer floor division. Any float-interpolating percentile will disagree.
  4. **Exemplar selection is deduplicate → 8 contiguous time buckets → within each
     bucket walk the length distribution (shortest, longest, then bisection) →
     round-robin across buckets → re-sort chronologically.** It is deterministic by
     construction; there is no sampling seed to match.
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

## Observations

Anything you noticed that the plan did not anticipate, including work that should exist
but is not in any track's scope. This is often the most useful section at review time.

- **`scripts/check_voice_pack_leak.py` cannot detect a leak that redaction rewrote.**
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
