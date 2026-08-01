# Track D — Prompt 02: Ingest, and the second is_from_me guard

**Depends on:** 01

Numbering implies a sequence; most of that sequence is imaginary. This line is the real
dependency. If your dependencies are complete, this prompt is ready — regardless of its
number. It does **not** mean two prompts run at once: one track is one session, one
branch, one prompt at a time, because interleaved commits destroy the per-prompt audit
trail. What it means is that the track can **reorder** — if `02` is blocked, and this
prompt depends only on `01`, do this one now. Two prompts that write the same file have
an edge even when neither reads the other's output.

## Context

Assumes the schema from `01`. Independent of `03`, `04` and `05` — any of them can run
next.

`POST /v1/voice-pack` carries the **second of the three `is_from_me` guards**. The Mac
holds the first and a build test holds the third. Yours is the one that runs in
production on data you did not generate, so it is the one that catches a regression in
someone else's code.

Read `TRACK.md` and `prompts/CONTRACTS.md` first if you have not already.

## Objective

The Mac's uploads are accepted, validated against the frozen schemas, and stored — and a voice pack that fails redaction assertions is rejected without being stored.

## Scope

**In scope:**

- `POST /v1/digest` — `202`, `409` on a duplicate `generated_at` for a device.
- `POST /v1/voice-pack` — `202`, and **`422 {"error":"redaction_failed"}` with nothing stored** when assertions fail.
- `POST /v1/heartbeat` — `204`, recording `digest_as_of` so staleness is computable.
- `DELETE /v1/users/{id}` — `204`, calling the partition drop from `01`.
- Schema validation with zod, generated from or checked against `contracts/schema/`. A response that does not match `contracts/openapi/boi-api.v1.yaml` is a bug.
- Bearer `device_token` auth.
- Structured JSON logging. Never log an exemplar or a gist string.

**Explicitly out of scope for this prompt:**

- Pairing — that is `03`.
- The brief — that is `05`.
- Trusting the Mac. Validate everything; the client is not the guard.

## Constraints

- **Paths you may modify:** `cloud/api/`
- **Paths you must not touch:** as listed in `TRACK.md`
- **Contracts to code against verbatim:** `contracts/openapi/boi-api.v1.yaml`, and the `digest.v1` / `voice_pack.v1` schemas. All frozen.
- **Libraries:** those already in the manifest. Adding one is an append to a shared
  file — record it in `NOTES.md`.
- **Conventions:** `CONTRACTS.md` § 6

## Definition of Done

Every item is concrete and observable by someone who did not do the work. You will
verify these yourself before reporting — see the next section.

- [ ] `POST /v1/digest` with `contracts/fixtures/digest/healthy.json` returns `202` and a `digest_id`; the same body again returns `409 {"error":"duplicate"}`
- [ ] `POST /v1/digest` with a body failing the schema returns `400 {"error":"validation","detail":...}`
- [ ] `POST /v1/voice-pack` with `contracts/fixtures/voice_pack/maya.json` returns `202`
- [ ] **The redaction guard:** a pack whose exemplars contain a phone number, an email address, or a dollar amount returns **`422 redaction_failed`**, and a follow-up query proves **nothing was stored**. Three separate tests, one per pattern.
- [ ] A pack with more than 40 exemplars, or an exemplar over 200 characters, is rejected
- [ ] No token returns `401 {"error":"unauthorized"}` on every authenticated route — asserted per route, not once
- [ ] `DELETE /v1/users/{id}` returns `204` and the delete test from `01` still passes when driven through the endpoint
- [ ] **No user content in logs:** a test captures log output during a voice-pack upload and asserts no exemplar string appears
- [ ] Every response shape matches the OpenAPI document — validate at least one response per endpoint against it programmatically
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

- curl transcripts for every endpoint, success and failure
- the three `422` redaction tests, with the not-stored assertion
- the log-capture test output
- full test output
- `git status` and `git log --oneline` for this worktree

## Commit

When the checklist is green:

```bash
git add cloud/api/
git commit -m "track-d: 02 ingest — <what changed>"
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
