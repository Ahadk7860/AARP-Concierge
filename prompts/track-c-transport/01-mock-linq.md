# Track C — Prompt 01: A mock faithful enough to diff against

**Depends on:** none

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

This is the first prompt in the track. Nothing exists beyond the foundation commit: the
frozen `cloud/shared/src/contracts.ts`, `StubChannel`, and the reconstructed spec and
transcripts under `contracts/`. Worktrees share neither untracked files nor installed
dependencies, so per-worktree setup happens here.

What comes after: the adapter (`02`) and webhook normalization (`03`) both run against
this server. Do not write either yet.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A local server implements the Linq v3 subset exactly as specified, including the failure modes, so the adapter can be built and tested with no token.

## Scope

**In scope:**

- Per-worktree setup: `npm install`, `.env` from `.env.example` with your track's values from `CONTRACTS.md` § 9.
- `POST /api/partner/v3/chats` — bearer auth, the documented request and response shapes, `200` with `id`/`status`/`protocol`/`trace_id`.
- `GET /api/partner/v3/chats/{id}` — send status.
- `GET /api/partner/v3/lines` — health. **The shape here is a guess** (`CONTRACTS.md` § 11 item 8); implement the spec and note the uncertainty.
- **Fault injection via `MOCK_LINQ_MODE`:** `up`, `degraded` (returns `sms` protocol), `banned` (`503 line_banned`), `ratelimited` (`429` with `Retry-After`). These are what make the adapter's error paths testable.
- Outbound webhook delivery to a configurable URL, signed `sha256=<hex>` HMAC-SHA256 of the raw body with `LINQ_WEBHOOK_SECRET`.
- An in-memory record of every request received, so tests can assert the exact wire payload.

**Explicitly out of scope for this prompt:**

- The `Channel` adapter — that is `02`.
- Inbound normalization — that is `03`.
- Improving on the spec. Where you believe the real API differs, implement the spec and write the belief into `NOTES.md`. A mock that silently corrects the spec hides the discrepancy it exists to surface.
- Group chats. Available in the API, deliberately out of MVP scope on consent grounds.

## Constraints

- **Paths you may modify:** `cloud/mock-linq/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `contracts/openapi/linq-v3-subset.yaml` and `contracts/transcripts/linq/*.json` — implement these literally.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `node cloud/mock-linq/src/server.ts` starts on port **3031** and does not bind any other port
- [ ] **Transcript conformance:** posting the exact body from `contracts/transcripts/linq/send_text_200.json` returns a response matching that transcript's recorded response, field for field. Asserted in a test.
- [ ] A request with no bearer token returns `401`
- [ ] `MOCK_LINQ_MODE=banned` makes `POST /chats` return `503` with a body matching `contracts/transcripts/linq/send_line_banned_503.json`
- [ ] `MOCK_LINQ_MODE=ratelimited` returns `429` with a `Retry-After` header
- [ ] `MOCK_LINQ_MODE=degraded` returns `200` with `protocol: "sms"`
- [ ] The webhook signature is verifiable: a test computes HMAC-SHA256 of the raw body with the secret and matches the `X-Boi-Signature` header the mock sent, including the `sha256=` prefix
- [ ] **The signature check is on the raw body, not the re-serialized object** — a test posts a body with unusual key ordering and asserts the signature still verifies
- [ ] The request recorder returns the exact payload sent, so a test can assert `message.parts` structure
- [ ] Existing tests still pass: `npm test -- cloud/channel cloud/mock-linq` exits zero
- [ ] Lint passes: `npm run lint && npm run typecheck` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh c` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- server startup log showing port 3031
- the transcript-conformance test output
- a curl transcript for each of the four modes, showing status and body
- the signature test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/mock-linq/
git commit -m "track-c: 01 mock-linq — <what changed>"
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
