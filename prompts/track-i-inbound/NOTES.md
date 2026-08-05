# Track I — inbound stream

## Prompt 01 evidence

- `npm run typecheck` passed.
- `npx vitest run cloud/channel/test/spectrum-stream.test.ts` passed (4 tests).
- The stream adapter remains injected because the Photon stream SDK surface is unverified.
- The wrapper only owns lifecycle and deduplication; persistence and routing remain out of scope.

## Prompt 02 evidence

- `npm run typecheck` passed.
- `npx vitest run cloud/inbound/handle-vault.test.ts` passed (5 tests).
- `HandleVault` accepts only an injected versioned key provider and emits AES-256-GCM
  envelopes with a random 96-bit nonce. Crypto/provider failures collapse to handle-free
  errors.
- `composeTapToSend` always retains copyable text. It creates an `sms:` link only for the
  frozen resolved-recipient variant and percent-encodes the recipient and body.

## Contract gaps

None. The eventual Photon adapter must translate its documented event id and monotonic cursor
into `SpectrumStreamEvent` without logging payload text.
