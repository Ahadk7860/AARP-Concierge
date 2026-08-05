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

## Residual gaps

- No live model selector/provider has been implemented or evaluated. The offline
  semantic gate is safety evidence only and does not make chat shipping-eligible.
- Follow-up draft generation and `draft_delivery.v1` composition are not implemented.
  Track J must not claim the architecture's tap-to-send outcome until that pass lands.

## Contract gaps

None. The executor accepts the frozen `ChatQuery` and `DigestV2` mirrors without
modifying the shared surface.
