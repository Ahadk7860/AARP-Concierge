# Phase 2 Frozen Contracts

The foundation commit is the only authority for these seams. Tracks must not edit the
schemas, fixtures, TypeScript mirrors, or this document. Report gaps in the track's
`NOTES.md` and stop at the gap.

| Contract | Producer | Consumer | Invariant |
|---|---|---|---|
| `digest.v2` | M | H, J | `synced_through` is required; understanding is derived and contains no counterparty quote. |
| `voice_pack.v2` | M | J | exemplar `text` is user-authored only; `answered` describes context without carrying prose. |
| `chat_query.v1` | J | J | Phase 2 exposes only `waiting_on_me`; no raw SQL or free-form query surface. |
| `chat_reply.v1` | J | I | every answer claim is licensed by a row; otherwise reply is `decline`. |
| `draft_delivery.v1` | J | I | receiver renders text always; only `resolved` recipients produce an `sms:` link. |

Privacy is a product invariant: contact handles and user↔Boi turns are encrypted before
storage. Contact handles live while the account does and cascade on delete. Turns expire
exactly 90 days after `occurred_at`; the retention job ships with the worker. No table,
fixture, log, or error may contain plaintext handles or counterpart message text.

Platform master-secret and key-envelope wiring is Track H's deployment responsibility;
Track I must not persist a handle until that capability exists.
