# Track D — Prompt 03: Boi texts first, because the alternative silently fails

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the schema from `01`. Independent of `02`, `04` and `05`.

The obvious flow is "here's our number, text it." **Don't.** *Filter Unknown Senders*
routes messages from non-contacts into a separate tab with no notification. If it is on,
the user texts the code, Boi replies perfectly, and nobody ever sees it.

You send first, attach a contact card so one tap saves Boi permanently, and offer an
`sms:` deep link so the thread opens directly. You are using `StubChannel`; Track C's
adapter drops in behind the same interface.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

A new user is texted first with a contact card, and a six-digit code exchanged in that existing thread returns a device token and a user salt.

## Scope

**In scope:**

- Signup: phone, email, terms. Phone is the join key.
- **Immediately** send the first message through `Channel`, including a `contact_card` block.
- An `sms:` deep link on the confirmation page that opens Messages in that thread.
- Verify the send came back as `imessage`; if not, we know before the user has downloaded anything.
- `POST /v1/pair`: six digits, single use, 10-minute expiry, bound server-side to one `user_id`, returning `device_token` and `user_salt`.
- Handle-mismatch detection — the number entered at signup may not be the one their iMessage is registered to. Plenty of people are reachable primarily by Apple ID email.

**Explicitly out of scope for this prompt:**

- The web page's visual design. A functional page is enough.
- Real SMS or iMessage delivery. `StubChannel` only.
- Rotating a `user_salt`. Issued once, ever.

## Constraints

- **Paths you may modify:** `cloud/api/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `POST /v1/pair` in `contracts/openapi/boi-api.v1.yaml`; `outbound.v1`; `Channel` — all frozen. `contracts/fixtures/outbound/first_contact_card.json` is the reference first message.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] Signup creates a user and **the first outbound message is sent before the response returns** — asserted against `StubChannel.sent`
- [ ] That first message contains **both** a `text` block and a `contact_card` block, matching the shape of `contracts/fixtures/outbound/first_contact_card.json`
- [ ] The confirmation page contains a valid `sms:` link with the assigned handle
- [ ] `POST /v1/pair` with a valid code returns `200` with `user_id`, `device_token` and a `user_salt` of at least 32 bytes
- [ ] **Single use:** the same code a second time returns `404 {"error":"invalid_code"}`
- [ ] **Expiry:** a code older than 10 minutes returns `404`. Test by controlling the clock, not by sleeping.
- [ ] A code is bound to one `user_id`: presenting user A's code from user B's device fails
- [ ] `StubChannel` in `degraded` mode (returning `sms` rather than `imessage`) is detected and flagged as a handle mismatch, rather than passing silently
- [ ] Codes are generated with a CSPRNG and are not sequential — assert over 1,000 generated codes
- [ ] Existing tests still pass: `npm test -- cloud/api cloud/brief cloud/card cloud/db` exits zero
- [ ] Lint passes: `npm run lint && npm run typecheck` exits zero
- [ ] Ownership holds: `bash scripts/check-ownership.sh d` exits zero — every path in `git diff --name-only main...HEAD` is one of this track's owned paths, or a foundation-owned shared file whose append is recorded in `NOTES.md`

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

- the first outbound message, in full, as recorded by `StubChannel`
- curl transcripts for pair success, reuse, expiry, and wrong-device
- the confirmation page HTML showing the `sms:` link
- the mismatch-detection test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/api/
git commit -m "track-d: 03 pairing — <what changed>"
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
