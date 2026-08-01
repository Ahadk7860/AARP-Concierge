# Track C — Prompt 02: The Channel adapter, with no provider semantics escaping

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the mock from `01` is running on 3031. Independent of `03` — either can run
next.

The interface you implement is frozen in `cloud/shared/src/contracts.ts`. The rule it
exists to enforce: **no provider semantics above this line.** Track D emits blocks and
must never learn whether delivery was blue, green, or grey. Every time you are tempted
to leak a Linq field upward, that is the abstraction earning its keep.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

`LinqChannel` implements `Channel` against the mock, translating blocks to Linq parts and mapping every documented failure to a typed error.

## Scope

**In scope:**

- `send()` — translate `OutboundMessage.blocks` to `message.parts`. Text, image, and contact card all map.
- **Capability negotiation, not assumption.** `capabilities()` is asked before tapbacks, rich links or threading are used, and unsupported features degrade silently.
- `health()` mapping to `up` / `degraded` / `banned`, tolerant of a `GET /lines` response shape different from the guess in the spec.
- Typed errors: `LineBannedError`, `RateLimitedError` (carrying `Retry-After`), `UpstreamError`. Track D branches on these.
- Idempotency: `OutboundMessage.idempotency_key` prevents a duplicate send on retry — asserted against the mock's request recorder.
- **A configurable rate limiter with a conservative default.** Real limits are unknown (`CONTRACTS.md` § 11 item 3); the number must live in config so the answer lands there and not in a code change.
- `LINQ_BASE_URL` drives everything, so production is a one-line swap.

**Explicitly out of scope for this prompt:**

- Inbound — that is `03`.
- Line assignment and automatic downgrade — that is `04`.
- Any real network call. There is no token.
- Twilio. Linq's RCS/SMS fallback is built in, so the Twilio adapter is a business-continuity concern for a later round, not a per-message degradation path.

## Constraints

- **Paths you may modify:** `cloud/channel/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `Channel`, `OutboundMessage`, `SendResult`, `Capabilities`, `ChannelHealth` — `cloud/shared/src/contracts.ts`, **frozen**. Implement it; do not modify it.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `LinqChannel` satisfies the `Channel` interface — `npm run typecheck` proves it, with no `any` and no `as` cast on the interface boundary
- [ ] **Round trip:** sending `contracts/fixtures/outbound/brief_message.json` against the mock produces a `SendResult`, and the mock's recorder shows a request matching `contracts/transcripts/linq/send_text_200.json`'s request
- [ ] `contracts/fixtures/outbound/first_contact_card.json` sends both a text part and a contact-card part — asserted against the recorder
- [ ] `MOCK_LINQ_MODE=banned` produces `LineBannedError`, not a generic throw — asserted
- [ ] `MOCK_LINQ_MODE=ratelimited` produces `RateLimitedError` carrying the `Retry-After` value
- [ ] **Idempotency:** two sends with the same `idempotency_key` result in exactly one request reaching the mock
- [ ] **No provider leakage:** `grep -rn 'linq' cloud/channel/src --include=*.ts -il` matches only the adapter files, and the `Channel` return types contain no Linq-specific field. State how you verified the second half.
- [ ] The rate limiter is configurable and enforced: a test sets a low limit and asserts the limiter delays or rejects
- [ ] Capability negotiation: a test with `groups: false` asserts a group send is refused rather than attempted
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

- `npm run typecheck` output
- the round-trip test output, including the recorded request payload
- the three typed-error tests
- the idempotency test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/channel/
git commit -m "track-c: 02 linq-adapter — <what changed>"
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
