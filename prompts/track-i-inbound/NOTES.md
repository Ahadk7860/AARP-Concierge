# Track I — inbound stream

## Prompt 01 evidence

- `npm run typecheck` passed.
- `npm run lint`, `npm run fixtures`, and `bash scripts/check-ownership.sh i` passed.
- The repository-wide `npm test` is not green in this worktree: unrelated database
  schema/catalog expectations fail against the foundation's Phase 2 tables, one scheduler
  process assertion reports `skipped`, and the known Xcode Python 3.9 runtime cannot import
  `datetime.UTC` in intelligence-bridge tests. Both changed suites above are green.
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

The Photon inbound SDK surface is still unverified. No global numeric or monotonic cursor
contract is assumed. `SpectrumStreamPort` carries opaque event ids/cursors and receives the
last durably committed cursor on every open; the eventual live adapter must map documented
Photon resume semantics into that seam without logging payload text. Do not implement or
claim the live adapter until its stream API has been verified.

## Review-fix evidence

- `npx vitest run cloud/channel/test/spectrum-stream.test.ts cloud/inbound/handle-vault.test.ts`
  passed (21 tests).
- `npm run typecheck` passed.
- Stream events become deduped/accepted only after consumer handling and durable checkpoint
  save both succeed. Either failure degrades health, closes the session, resumes from the
  previous checkpoint, and permits redelivery of the same event id.
- Opaque cursors are never compared. Unique late/partitioned events are delivered, and a
  required injected checkpoint seam makes the process restart boundary explicit.
- Backoff survives a merely successful open and resets only after a processed event or the
  configured stability interval; flapping transports retain exponential delay.
- Handle ciphertext AAD binds purpose, algorithm, key version, `user_id`, and `contact_id`.
  Cross-user, cross-contact, and swapped-identity opens fail with handle-free errors.
- Tap-to-send accepts only bounded E.164 or conservative email-compatible recipients.
  Whitespace, controls, URI delimiters, malformed values, and oversized values retain the
  draft as copyable text with no link.
