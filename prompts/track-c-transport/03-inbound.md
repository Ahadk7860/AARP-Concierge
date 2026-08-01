# Track C — Prompt 03: Inbound webhooks, verified before they are trusted

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the mock from `01`. Independent of `02` — either can run next.

The boundary here is `inbound.v1`. You own verification and normalization; Track D owns
what happens to a normalized message. Signature verification is fully testable today
even though the real scheme is unconfirmed (`CONTRACTS.md` § 11 item 2) — so build it
now and make the scheme swappable.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

Inbound webhook bodies are signature-verified and normalized into `inbound.v1`, rejecting anything unverified before it is parsed as meaningful.

## Scope

**In scope:**

- `normalizeInbound(rawBody, signature)` per the frozen interface. **Throws on signature failure. Never returns a partially-normalized message.**
- Verification on the **raw body bytes**, not a re-serialized object — key reordering must not break it.
- Constant-time comparison. A timing-variable compare on a signature is a real vulnerability, not a nitpick.
- Normalizing all five inbound kinds: `text`, `tapback`, `read_receipt`, `delivery_receipt`, `typing`.
- W3C trace ID passthrough into `trace_id`.
- `user_id: null` when the handle is unknown — pairing resolves it, and that is Track D's job.
- A swappable verification strategy, since the real scheme is unconfirmed.

**Explicitly out of scope for this prompt:**

- Acting on the message. A `2` reply meaning 'send draft two' is Track D's concern.
- Pairing-code lookup.
- Storing anything.

## Constraints

- **Paths you may modify:** `cloud/channel/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `inbound.v1` — `contracts/schema/inbound.v1.json`, frozen. `contracts/transcripts/linq/inbound_webhook.json` is the reference body.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] The reference body from `contracts/transcripts/linq/inbound_webhook.json` normalizes to a document that passes `python3 scripts/validate_fixtures.py inbound.v1 <output>`
- [ ] The normalized output for that body matches `contracts/fixtures/inbound/draft_choice_2.json` in every field except `provider_message_id` and timestamps — asserted
- [ ] **A body with a wrong signature throws**, and the thrown error is distinguishable from a parse error — asserted
- [ ] **Key reordering does not break verification:** a test re-serializes the body with keys in a different order, signs the original raw bytes, and asserts verification still succeeds
- [ ] Comparison is constant-time: the implementation uses `crypto.timingSafeEqual` (or equivalent) — show the line
- [ ] All five inbound kinds normalize, each asserted with a fixture you construct
- [ ] An unknown handle yields `user_id: null` rather than an error
- [ ] The verification strategy is swappable: a test injects an alternative verifier and asserts it is used
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

- validator output for the normalized reference body
- the full normalized document
- the wrong-signature and key-reordering test outputs
- the constant-time comparison line, quoted
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/channel/
git commit -m "track-c: 03 inbound — <what changed>"
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
