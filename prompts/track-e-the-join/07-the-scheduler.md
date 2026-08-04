# Track E — Prompt 07: nothing ever fires the brief

**Depends on:** 05 and 06. **Read first:** `01-strategy/MVP_GAP_AUDIT.md`, finding 1.

## Context

`scheduler.ts` defines `dueUsers()` and `isDue()`. `run.ts` defines `runForUser()`. Search
the non-test cloud source for callers of either and you get **only their own definitions**.
The real callers are `scheduler.test.ts` and the e2e runner. `node-cron` is a dependency
and appears in production code exactly once, in a comment.

There is no daemon. Nothing wakes at 8am.

This is the failure you named at `TickDeps` — *"a type with no producer cannot be wrong"* —
one level up, and no `NOTES.md` has it. Every hard part is done: idempotency on
`unique (user_id, scheduled_for)`, the canonical 08:00-local instant rather than tick time,
bounded retry with `nextRetry`. They are correct, tested, and never called.

`BOI_BRIEF.md`: *"Ranking is acquisition. **The daily brief is retention.**"* We have built
retention as a library.

## Objective

A process that wakes, finds who is due, and delivers. Started once, it produces one brief
per user per morning without supervision.

## Scope

**In scope:**

- `cloud/scheduler/`: the process. Wake on an interval, `dueUsers()`, `runForUser()` each,
  structured log per outcome.
- Concurrency: N users at once, bounded. One user's failure never blocks another's.
- A single-instance guard. Two schedulers must not double-send — the DB constraint already
  makes that safe, but "safe" and "quiet" are different, and a duplicate that is silently
  swallowed is a duplicate you never learn about.
- Graceful shutdown: SIGTERM finishes in-flight ticks and stops taking new ones.
- The fleet-health read the audit found missing: a query over `devices.last_heartbeat_at`
  that alarms when a **fleet-wide fraction** goes quiet. The Mac side of this is built
  (`Heartbeat.swift`, the stall alarm). The server half — the only place the correlation is
  possible — does not exist, and `CONTRACTS.md` § 10 hole 8 calls it *the canary for a whole
  class of failures*: an auto-update that drops FDA for every Mac on the same day looks like
  many unrelated quiet users and is visible only in aggregate.

**Explicitly out of scope:**

- Spectrum. `08`.
- A web dashboard. A log line is enough.
- Autoscaling, queues, workers. One process, one interval.

## Constraints

- **Paths:** `cloud/scheduler/` (new, yours), and `cloud/brief/src/run.ts` for the
  construction site only.
- Do not change `runForUser`'s body. If it needs a change, that is a finding.
- Timezones come from the user row. Do not infer from the phone number.

## The trap this prompt exists inside

A scheduler is the easiest thing in this repo to write a test for that cannot fail. "It
called `runForUser` three times" is satisfied by a loop over a mocked list. **Assert on
briefs in the database and messages at the channel**, on a controlled clock, across a
simulated multi-day span — not on call counts.

Specifically: a test that advances a fake clock across three mornings and asserts exactly
three briefs, and one that runs two scheduler instances against one database and asserts
one send with the duplicate *reported*, are the two that matter.

## Definition of Done

- [ ] `npm run scheduler` starts a process that delivers to a due user with no manual step
- [ ] Three simulated mornings produce exactly three briefs and three sends, asserted in
      the database and at the channel — not on call counts
- [ ] A user whose tick throws does not prevent a later user's brief in the same sweep
- [ ] Two instances against one database send once, and the loser **logs the collision**
      rather than swallowing it
- [ ] SIGTERM drains in-flight work; no partial brief, no lost row
- [ ] Timezone correctness: two users in different zones are each served at their own 08:00,
      asserted on a controlled clock
- [ ] The fleet-heartbeat query exists, and a test with 10 simulated devices — 8 quiet on
      the same day — trips it, while 2 quiet does not
- [ ] `bash scripts/gate.sh e` green

## What to report

The three-morning test output and the two-instance test output. Those are the two that say
this is a product rather than a library.
