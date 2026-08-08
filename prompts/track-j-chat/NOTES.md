# Track J

## Prompt 01 evidence

- `npm run typecheck`
- `npm test -- cloud/chat/src/waiting-on-me.test.ts`
- `bash scripts/check-ownership.sh j`

## Prompt 02 evidence

- `npm run typecheck`
- `npm test -- cloud/chat/src/reply.test.ts`
- Licensed name/number, cross-contact, malformed-renderer, freshness, and
  stale-present-tense mutations decline.
- `bash scripts/check-ownership.sh j`

## Prompt 03 evidence

- `npm run typecheck`
- `npm test -- cloud/chat`
- Exactly 50 mixed semantic cases: 15 answered correctly, 35 declined correctly,
  zero fabricated in the offline provider gate.
- The offline report keeps `shipping_eligible` and `passed` false.
- `bash scripts/check-ownership.sh j`

## Prompt 04 evidence

- `npm run typecheck`
- `npm test -- cloud/chat`
- `bash scripts/check-ownership.sh j`
- `FollowUpDraftProvider` receives only the selected relationship's bounded derived
  understanding/fact allowlist and its matching `voice_pack.v2` user-authored exemplars.
  The projection contains no digest corpus, display name, handle, raw messages, or
  counterpart prose.
- Recorded-provider tests cover cross-contact voice-pack swaps, unexpected-field
  injection, cross-contact claim swaps, arbitrary-provider-prose refusal, provider
  failure, length refusal, strict frozen voice-pack validation, malformed Unicode, and
  the user-voice-only projection canary.
- A successful `DraftProposal` contains exactly `contact_id` and `text`. Track J can
  compose frozen `draft_delivery.v1` only after Track I supplies either a resolved
  recipient or the explicit unavailable case bound to the same `contact_id`; this path
  never resolves, links, sends, or invents a handle.
- `DraftProposal` is an in-process, frozen capability tracked by Track J. A caller cannot
  forge a lookalike `{contact_id,text}` and route it into delivery; join must compose the
  frozen wire `DraftDelivery` before crossing a process or persistence boundary.
- Recipient resolution must come directly from Track I's vault-backed resolver. Track J
  verifies the resolver's `contact_id`, copies and freezes its recipient, then consumes
  the proposal capability exactly once. A failed contact mismatch does not consume it,
  so a corrected vault lookup can retry. Durable Track I delivery idempotency remains the
  replay defense after the frozen `DraftDelivery` crosses the process boundary.
- Review hardening removed arbitrary provider prose from the production path. The
  provider may select only one of two closed, deterministic acknowledgement templates
  and must license it to the exact selected open thread. Track J renders the final text.
  A valid open-thread claim can therefore never smuggle `yes i already paid and booked
  the room` (or any other model-written commitment) into `DraftProposal`.

## Residual gaps

- No live model selector/provider has been implemented or evaluated. The offline
  semantic gate is safety evidence only and does not make chat shipping-eligible.
- No live follow-up draft provider has been implemented or evaluated against the
  50-case fabrication suite. Recorded-provider success is seam evidence only: Track J's
  shipping status remains false.
- Join must exercise Track I recipient resolution plus both resolved-link and
  unavailable-copyable-text delivery. Track J composes the contract but does not own or
  claim the tap-to-send UI outcome.
- The closed templates intentionally do not answer the counterpart's question or make a
  specific commitment. Expanding beyond acknowledgement/defer requires a real provider,
  a deterministic fabrication gate, and the live 50-case evaluation before shipping.

## Contract gaps

None. The executor accepts the frozen `ChatQuery` and `DigestV2` mirrors without
modifying the shared surface.
