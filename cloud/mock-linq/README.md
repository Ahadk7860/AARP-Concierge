# Mock Linq Partner API v3

A local implementation of `contracts/openapi/linq-v3-subset.yaml`, owned by Track C.

**This is not a convenience fixture.** The spec it implements has never been run against
a live Linq account — tokens are rep-provisioned and the sales cycle has not closed. The
mock is a written-down hypothesis about a wire format we have never seen respond, and its
job is to be **diffable**. When a token lands, the first task is not to patch the adapter:
it is to run one real send, diff the response against `contracts/transcripts/linq/`, and
amend the contract through the procedure in `prompts/WORKTREE-PROTOCOL.md`.

So the mock implements the spec **exactly, including where we suspect the real API
differs**. Every such suspicion is written down in `prompts/track-c-transport/NOTES.md`
rather than silently corrected here. A mock that quietly improves on the spec hides the
discrepancy it exists to surface.

## Run

```bash
node cloud/mock-linq/src/server.ts
```

Listens on `127.0.0.1:3031` (Track C's assigned port, `CONTRACTS.md` § 9). Structured JSON
logs to stdout.

## Endpoints

Served under **both** `/api/partner/v3` (the path recorded in the transcripts) and the
bare root (the `http://localhost:3031` server entry in the OpenAPI document). See NOTES.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/chats` | send. `200 {id,status,protocol,trace_id}` |
| `GET` | `/chats/{id}` | send status |
| `GET` | `/lines` | line health — **shape is a guess**, `CONTRACTS.md` § 11 item 8 |

Control plane, namespaced so it can never be mistaken for the Linq surface and excluded
from the recorder:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/__mock/requests` | every recorded request, raw body included |
| `DELETE` | `/__mock/requests` | clear the recorder |
| `GET` | `/__mock/config` | the effective config |
| `POST` | `/__mock/webhooks/deliver?url=` | deliver the **raw** posted bytes as a signed webhook |

## Fault injection

`MOCK_LINQ_MODE` selects one. These are what make the adapter's error paths testable with
no token.

| Mode | `POST /chats` |
|---|---|
| `up` | `200`, `protocol: "imessage"` |
| `degraded` | `200`, `protocol: "sms"` |
| `banned` | `503 {"error":"line_banned","line_id":"..."}`, verbatim from the transcript |
| `ratelimited` | `429` with `Retry-After` |

`banned` is the failure mode that actually hurts: platform uptime can read 100% while one
tenant's line is dead for every user assigned to it.

## Transcript replay

The mock loads `contracts/transcripts/linq/*.json` at startup. A request body that
deep-equals a recorded request is answered with that transcript's recorded response,
verbatim. Anything else gets a deterministic synthesized response of the same shape. This
makes transcript conformance an assertion against the transcript itself rather than
against a paraphrase of it.

## Webhook signing

`X-Boi-Signature: sha256=<hex>`, HMAC-SHA256 over the **raw request bytes** with
`LINQ_WEBHOOK_SECRET`. The scheme is a placeholder (`CONTRACTS.md` § 11 item 2).

The raw buffer is threaded end to end and never round-tripped through `JSON.parse` /
`JSON.stringify`. Signing a re-serialized object is the classic way to ship a signature
check that passes every test and fails on the first live webhook, because key ordering and
whitespace normalize away. `server.test.ts` asserts this directly with a deliberately
oddly-ordered body.

## Configuration

Every answer to the open Linq questions in `CONTRACTS.md` § 11 must land in config, not in
a code branch — they are sales-call answers, and code that encodes a guess about them has
to be rewritten when the call happens.

| Variable | Default | Meaning |
|---|---|---|
| `MOCK_LINQ_PORT` | `3031` | |
| `MOCK_LINQ_HOST` | `127.0.0.1` | |
| `MOCK_LINQ_MODE` | `up` | `up` \| `degraded` \| `banned` \| `ratelimited` |
| `MOCK_LINQ_LINE_ID` | `line_a1` | § 11 item 7 — tenants per line unknown |
| `LINQ_FROM_HANDLE` | `+15550100123` | |
| `LINQ_WEBHOOK_SECRET` | `dev-secret-change-me` | |
| `MOCK_LINQ_WEBHOOK_URL` | unset | where webhooks are delivered |
| `MOCK_LINQ_EXPECTED_TOKEN` | unset | unset accepts any non-empty bearer |
| `MOCK_LINQ_RETRY_AFTER` | `30` | § 11 item 3 — real limits unknown |
| `MOCK_LINQ_PATH_PREFIXES` | `/api/partner/v3,` | comma-separated |
| `MOCK_LINQ_TRANSCRIPT_DIR` | `contracts/transcripts/linq/` | |
| `MOCK_LINQ_LOG_LEVEL` | `info` | |

Only `MOCK_LINQ_PORT`, `MOCK_LINQ_MODE`, `LINQ_FROM_HANDLE` and `LINQ_WEBHOOK_SECRET` are
in `.env.example`. The rest have working defaults and were not added, because `.env.example`
is a foundation-owned shared file and an append there is a merge conflict for three other
tracks.

## Tests

```bash
npm test -- cloud/channel cloud/mock-linq
```

The suite drives the server through `fastify.inject()` rather than a socket, so it binds
exactly one real port — `3033`, for the webhook receiver, inside Track C's assigned
3030–3039 range. Running the suite never collides with a hand-run server on 3031.

## Why `server.ts` is one file

Node's type stripping does not resolve `./x.js` to `x.ts`, and this module must run under
plain `node` with no build step. An entry module that has to start with `node
cloud/mock-linq/src/server.ts` therefore cannot carry relative imports.
