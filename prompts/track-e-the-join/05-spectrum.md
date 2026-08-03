# Track E — Prompt 04: Photon, and the first message a human receives

**Depends on:** 03, green, with artifacts you have read by hand.

## Context

Read `SPECTRUM_INTEGRATION.md` in the strategy folder before starting. It contains the
mapping, the quotas, the allowlist constraint and the signature scheme, all sourced from
Photon's docs and SDK.

The short version: Spectrum is a full agent framework and we are using roughly 5% of it.
It sits **behind** the frozen `Channel` interface. Nothing above `cloud/channel/` learns
the word "Photon."

Project `boi-imessage`, projectId `bdf7016f-a57b-4736-9a90-34fd33e95828`, **Free plan** —
which means a shared line pool, which means Boi can only message handles registered as
Users in the dashboard.

## Objective

`SpectrumChannel` implements `Channel`, the e2e runner passes with it substituted for
`StubChannel`, and exactly one real brief arrives on a real phone.

## Scope

**In scope:**

- `cloud/channel/src/spectrum-channel.ts` — `send`, `capabilities`, `health`, `normalizeInbound`.
- `cloud/channel/src/spectrum-signature.ts` — HMAC-SHA256 over `v0:<timestamp>:<rawBody>`,
  compared against the hex after `v0=` in `X-Spectrum-Signature`, with the timestamp from
  `X-Spectrum-Timestamp` and a 5-minute replay window.
- Chat-GUID persistence keyed by `user_id`, so `space.create()` is called once per recipient
  ever and the 50-new-conversations-per-line-per-day quota is spent only on real enrolments.
- `contracts/transcripts/spectrum/**` — recorded fixtures so the tests run without a line.
- The one frozen change: `"spectrum"` added to `InboundMessage.provider`.

**Explicitly out of scope:**

- Adopting `app.messages`, Spectrum's content builders above the channel, or any second provider.
- `@spectrum-ts/imessage-local`. Track A's reader stays.
- Group support. It does not exist on a shared pool and the MVP does not use it.

## Constraints

- **Paths you may modify:** `cloud/channel/src/spectrum-*.ts` and their tests,
  `contracts/transcripts/spectrum/`, and the single union in `cloud/shared/src/contracts.ts`.
- **Do not delete `cloud/mock-linq/` or `linq-v3-subset.yaml`.** They are the only evidence
  that the `Channel` seam holds for more than one implementation — which is the entire
  property this swap depends on. Retire them in a later prompt, after this one is green.
- **Contracts:** `Channel`, `outbound.v1`, `inbound.v1` — frozen but for the one union.

## Three decisions the prompt is making for you

1. **Verify the HMAC yourself.** `app.webhook()` is async and `normalizeInbound` is not.
   Widening it to return a promise unfreezes the most important interface in the system for
   a signature check that is nine lines. Write the nine lines.
2. **`capabilities()` comes from config, not from probing.** The plan tier is a
   sales-call answer and `CONTRACTS.md` § 11 already requires those to land in config. On
   Free: `groups: false`, everything else true.
3. **`"unknown"` does not become `"sms"`.** Spectrum's `service` field has four values and
   `SendResult.protocol` has three. "We do not know whether this was blue" and "this was
   green" are different facts and only one of them is true. Carry `null` or widen; do not
   guess. Record which you chose and why in `NOTES.md`.

## Before the live send

Do this in order and do not skip:

1. Open [debug.photon.codes](https://debug.photon.codes), text the debug bot, and read back
   the **exact handle Apple sends from.** It is frequently an Apple Account email rather
   than a phone number. Add *that* handle under Users in the dashboard.
2. Confirm the e2e runner is green with `StubChannel` on the current commit.
3. Run the e2e runner with `SpectrumChannel` in **dry-run**: everything up to `send`, then
   print the outbound blocks and stop.
4. Read the two drafts out loud. You are about to text them to a human.

Then send one.

## Definition of Done

- [ ] `SpectrumChannel` satisfies `Channel` with no `any` and no casts at the boundary
- [ ] Signature verification: a valid signature passes; a tampered body, a wrong secret, a missing header and a timestamp at t−5:01 each fail, and t−4:59 passes
- [ ] A missing signature header is `401 bad_signature`, never a 500
- [ ] `send` maps text and image blocks; the image block is sent as an `attachment` with an explicit `mimeType` because the card is generated and has no extension to infer from
- [ ] The chat GUID is persisted on first contact and reused — assert that a second send to the same user calls `space.get`, not `space.create`
- [ ] `capabilities()` reports `groups: false` on the Free tier, from config
- [ ] `health()` returns `degraded` at ≥80% of the 5,000/day quota and `banned` after repeated `Target not allowed for this project`
- [ ] Tests pass against recorded transcripts with **no live line** — unset the credentials and they still run
- [ ] `npm run e2e` passes with `SpectrumChannel` substituted, in dry-run
- [ ] **One real brief received on a real phone.** Screenshot it. That screenshot is the deliverable this entire repo has been building toward
- [ ] `bash scripts/check-ownership.sh e` exits zero, and the `contracts.ts` union widening is recorded in `NOTES.md`
