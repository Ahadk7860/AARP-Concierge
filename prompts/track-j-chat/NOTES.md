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
  injection, cross-contact claim swaps, unlicensed dates/times/places/amounts/names,
  provider failure, length/register refusal, and the user-voice-only projection canary.
- A successful `DraftProposal` contains exactly `contact_id` and `text`. Track J can
  compose frozen `draft_delivery.v1` only after Track I supplies either a resolved
  recipient or the explicit unavailable case; this path never resolves, links, sends,
  or invents a handle.

## Residual gaps

- No live model selector/provider has been implemented or evaluated. The offline
  semantic gate is safety evidence only and does not make chat shipping-eligible.
- No live follow-up draft provider has been implemented or evaluated against the
  50-case fabrication suite. Recorded-provider success is seam evidence only: Track J's
  shipping status remains false.
- Join must exercise Track I recipient resolution plus both resolved-link and
  unavailable-copyable-text delivery. Track J composes the contract but does not own or
  claim the tap-to-send UI outcome.
- The deterministic surface scanner is defense in depth for common dates, times,
  amounts, and capitalized name/place forms; it is not a general named-entity model.
  A real provider must still pass the mutation/eval gate before shipping.

## Contract gaps

None. The executor accepts the frozen `ChatQuery` and `DigestV2` mirrors without
modifying the shared surface.
