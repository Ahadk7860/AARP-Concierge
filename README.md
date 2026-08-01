# Boi

Consumer AI assistant that lives in iMessage. A companion Mac app reads local iMessage
history, so Boi is the only assistant that knows your *relationships*.

> Every AI assistant can read your calendar. Boi is the only one that can read the room.

Each morning Boi texts you at most three people who are waiting on a reply, and for each
one it drafts **two** candidate messages in your own voice. It never sends them.

## This repo

Built by four agents working in parallel, each in its own git worktree.
**Start at [`prompts/LAUNCH.md`](prompts/LAUNCH.md).**

| Path | What |
|---|---|
| `contracts/` | **Frozen.** JSON Schemas, OpenAPI specs, fixtures, recorded transcripts. |
| `prompts/` | The build plan: contracts, rules, and one folder of prompts per track. |
| `scripts/` | Worktree setup, fixture generation, schema validation, ownership checks. |
| `mac/` | Track A — Swift. The sensor. |
| `intelligence/` | Track B — Python. Voice pack, gist, drafter, validator, eval. |
| `cloud/channel/`, `cloud/mock-linq/` | Track C — TypeScript. The channel spine. |
| `cloud/api/`, `cloud/brief/`, `cloud/card/`, `cloud/db/` | Track D — TypeScript. The product surface. |
| `cloud/shared/` | **Frozen.** Shared types and the stub channel. |

Strategy documents live outside this repo, in `Documents/Claude/boi-imessage/`:
`BOI_BRIEF.md` (what and why), `BOI_ARCHITECTURE.md` (how, including the drafting layer
in §6.5–6.6), `WORKSTREAMS.md`, and the access-validation findings. A read-only mirror of
`prompts/` is at `Documents/Claude/boi-imessage/06-prompts/`.

## Quick start

```bash
python3 scripts/make_synthetic_chatdb.py --out /tmp/boi-a/chat.db   # a fixture corpus
python3 scripts/validate_fixtures.py                                # check every fixture
npm install && npm test                                             # TypeScript harness
pip install -e '.[dev]' && python -m pytest                         # Python harness
swift test --package-path mac                                       # Swift harness
```

The fixture corpus deliberately leaves one row sitting in an unmerged write-ahead log, so
a reader that opens the database with `immutable=1` sees one row fewer than one using
`mode=ro`. That difference is how you prove the reader is not silently freezing the
corpus — the failure mode that raises no error, passes on a quiet test machine, and loses
recent messages forever on a live iCloud-syncing Mac.

## Non-negotiables

These are in `prompts/CONTRACTS.md` and every track brief. They are cheap now and
impossible to retrofit.

- **Never join users to each other.** Two users both texting the same person must never
  link those records. `contact_id = HMAC(user_salt, normalized_handle)` makes it
  arithmetically unavailable, not merely forbidden by policy.
- **Never auto-send.** The approval tap costs nothing and buys everything.
- **`is_from_me = 1` on anything that leaves the Mac as text**, asserted three times: the
  SQL query, the upload boundary, and a test that fails the build.
- **`as_of` on every fact**, end to end. The failure mode is Boi confidently saying
  something false about a person's friend.
- **Degrade, never fabricate.** No drafts beats bad drafts. A vague gist beats a
  hallucinated one.
- **Don't ship reciprocity.** sd 0.034 across 25 real relationships — it carries almost no
  information, and it is the most legally dangerous metric in the category.
- **Invitation, never verdict.** Every reveal ships with a one-tap remedy.
- One-click delete that actually deletes, derived data included. US only at launch.
