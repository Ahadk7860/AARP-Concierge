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

## SMS URL contract follow-up

- The recipient is validated before interpolation, then preserved raw so E.164 links match
  the pinned `sms:+15551234567&body=<encoded>` contract byte-for-byte. Only the body is
  percent-encoded.
- Email punctuation rejects the same URL-changing delimiters as Swift
  `ThreadHandoff.isUsable`: `&?#/\\<>"'`, whitespace, and controls. Focused tests include
  every delimiter and the exact E.164 URL bytes.
- Ill-formed UTF-16 (including a lone surrogate) cannot make `encodeURIComponent` drop a
  draft: delivery degrades to unavailable while preserving the original copyable text.

## Prompt 03 evidence

- Merged current `main` into this worktree before implementation to consume migration 012,
  the frozen private repository interface, and current foundation grants. No rebase.
- `PostgresPhase2PrivateRepository` implements ciphertext-only handle writes/reads,
  idempotent turn appends, an atomic inbound-plus-optional-outbound claim, and global
  expiry purging. Live PostgreSQL tests prove user scoping, duplicate claims, the exact
  90-day boundary, idempotent purge, and user-first cascade deletion.
- `TurnVault` uses AES-256-GCM with AAD bound to purpose, algorithm, key version, user,
  direction, and turn id. Cross-user, direction, and turn swaps fail with plaintext-free
  errors.
- `EncryptedPrivateStore` is the only plaintext-to-repository boundary. Handle writes and
  reads refuse with `private_key_capability_unavailable` unless H's key capability is
  injected. Both turn directions are encrypted before repository I/O and expire exactly
  90×24 hours after `occurred_at`.
- `InboundRouter` exposes injected adapters for the existing deterministic intent path and
  J's closed `waiting_on_me` chat seam. Deterministic routing wins; only unhandled text
  reaches chat. Successfully decided inbound/outbound turns are claimed atomically, and a
  required idempotent delivery port retries with the same key after transport failure.
  Provider redelivery returns a typed duplicate only after the delivery call succeeds.
- `TurnRetentionWorker` coalesces concurrent runs, reports only operational success/failure,
  ships with a concrete daily interval scheduler, and leaves runtime lifecycle ownership
  at the composition boundary.
- `npx vitest run cloud/inbound cloud/channel/test/spectrum-stream.test.ts` passed (46 tests).
- `npx vitest run cloud/db/src/turns.test.ts --reporter=verbose` passed (4 live PostgreSQL tests).
- `npm run typecheck` passed.

## Remaining live gates

- The Photon inbound SDK stream/resume shape is still unverified; the adapter remains an
  injected opaque-cursor seam and no live Photon call was guessed.
- H must inject the platform key provider and install/start the retention schedule in the
  deployed worker. J must supply the closed chat port. K must prove those real process
  boundaries and outbound delivery idempotency end to end.
