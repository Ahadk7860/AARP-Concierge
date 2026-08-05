## Where (repo, branch, worktree, last commit sha)

`/Users/skylerluk/Dev/boi-imessage`, `main`, `/Users/skylerluk/Dev/boi-imessage`, `594485ec57e058c3f126eb57f0d866c629b1782d` before this checkpoint.

## Done (finished AND verified, one line each)

Foundation contracts/interfaces, notification hook, single DB pool, external card deletion seam, Swift v2 mirrors, and merge-aware K ownership gate are committed and pushed on `main`.
Track H cloud runtime/private card Railway packaging passed final independent review and is pushed as `phase2-h-cloud-runtime`.
Track M two-way understanding/contextual voice v2 passed final independent review and is pushed as `phase2-m-two-way-reading`.
Track I stream safety, encrypted handles/turns, exact 2160-hour retention, durable outbox, and routing passed final independent review and is pushed as `phase2-i-inbound`.
Track J closed chat and one-shot licensed draft delivery passed final independent review and is pushed as `phase2-j-chat`.
Track K merged approved H/M/J/I without conflicts; combined focused tests, live Postgres tests, typecheck, and fixtures passed through commit `16fb0d7`.

## In flight (what was being worked on, exact current state)

Track G `phase2-g-mac-shipping` has reviewed helper commit `7d63ce3`; two P2 fixes (approval-error status recovery and coherent helper/client deadlines) were being edited and were uncommitted at last observation.
Track K `phase2-k-join` was at verified commit `16fb0d7`; K-01 v2 dual-write/dual-accept sync→upload→API→Postgres wiring had just started after instruction to merge `main` `594485e`. Its post-STOP worktree was intentionally not inspected.
Current `main` was clean before adding this handoff file.

## Not started (remaining work, in order)

Finish and independently re-review the two Track G P2 fixes; then commit and push G.
Merge approved G into K with an explicit merge commit and re-run focused/ownership gates.
Finish K-01 v2 Mac sync/upload/API/Postgres round trip and independently review it.
Implement K-02 H/I/J runtime composition, checkpoint adapter, key-provider adapter, retention lifecycle, readiness, and durable delivery integration.
Add a documented real Photon/Spectrum adapter and run synthetic inbound/outbound restart tests.
Add and evaluate live selector/draft providers; keep chat non-shipping until the live 50-case gate passes.
Run Railway deployment, Developer ID signing/notarization, daemon approval, and physical four-wake/iPhone-message evidence.
Only after final review, decide whether to merge `phase2-k-join` into `main`.

## Next 3 actions (verbatim, executable, written for an agent that has never seen this repo)

1. `cd /Users/skylerluk/Dev/boi-imessage-track-g && git status --short --branch && git diff --check && git diff -- mac/Sources/BoiKit/WakeSchedulerHelper.swift mac/Sources/BoiWakeHelper/main.swift mac/Tests/BoiKitTests/WakeSchedulerHelperTests.swift mac/Tests/BoiKitTests/WakeSchedulerLifecycleTests.swift`
2. Finish only the two recorded G P2 fixes, run `cd /Users/skylerluk/Dev/boi-imessage-track-g/mac && swift test --filter 'WakeSchedulerHelper|WakeSchedulerLifecycle'`, then commit them as `track-g: close approval and timeout races` and request an independent re-review before pushing.
3. `cd /Users/skylerluk/Dev/boi-imessage-track-k && git status --short --branch && git log --oneline --first-parent -8 && git diff --check`; inspect and either finish or revert only the existing K-01 edits before doing any new work.

## Contracts touched (shared types/schemas/interfaces modified or needing modification)

Committed on `main`: frozen `digest.v2`, `voice_pack.v2`, `chat_query.v1`, `chat_reply.v1`, and `draft_delivery.v1` schemas/fixtures; TypeScript/Python/Swift mirrors; Phase 2 private repository interfaces; single runtime pool; external card-store deletion installer; Track G/K ownership grants.
Track I adds migrations 013/014 for encrypted outbox and exact elapsed-hour retention on its branch.
K-01 must extend real uploader/API/repository acceptance for v2 without weakening frozen schemas; prefer explicit dual-write/dual-accept until all v1 consumers migrate.
K-02 needs a narrow adapter from H's synchronous key capability to I's async versioned key provider and one durable opaque Spectrum checkpoint implementation.

## Traps (what a fresh agent would plausibly get wrong here, specific. This section is the whole reason the file exists.)

Do not merge feature branches into `main`; integration belongs on `phase2-k-join` until the user approves the final merge.
Do not trust green track tests alone: every completed track required independent review and sequential fix commits.
Do not run `/usr/bin/pmset` from the app; RTC scheduling must go through the signed, admin-approved, argument-free SMAppService LaunchDaemon helper.
G must treat a thrown `SMAppService.register()` followed by `.requiresApproval` as pending approval, not terminal degradation.
G's helper transaction deadline must finish before the client timeout; otherwise the UI can report failure while root schedules later.
Never recompute an inbound reply on retry: I's encrypted durable outbox is the canonical reply/no-reply and delivery key.
J draft proposals are one-shot in-process capabilities; resolve through I's vault-backed resolver and compose `draft_delivery.v1` in the same module instance.
Never expose the card service publicly; only API is public, with GET-only signed-card proxy and API-owned private cache policy.
The project test that invokes `/usr/bin/python3` hits macOS Python 3.9 and `datetime.UTC`; use/repair the declared Python 3.11+ test interpreter rather than changing product logic.
K ownership is first-parent/combined-diff aware as of `594485e`; do not replace it with `git diff main...HEAD` or inherited track paths become false violations.
Do not guess Photon cursor/SDK shapes; current I ports intentionally use opaque cursors and require verified documentation.

## Open questions (blocked on a human)

Railway authentication/project creation, managed Postgres, private card volume, domains, and production secrets need Skyler.
Developer ID Application identity for `skylerluk@gmail.com`, notarization credentials, installation in `/Applications`, FDA, and admin LaunchDaemon approval need Skyler.
Photon/Spectrum credentials and authoritative stream API documentation/SDK access need Skyler.
A production model/provider choice and API key for the live 50-case selector/draft evaluation need Skyler.
Final merge of `phase2-k-join` into `main` remains a user decision.
