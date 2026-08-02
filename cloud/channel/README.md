# Channel — the transport abstraction

Owned by Track C. The `Channel` interface is frozen in `cloud/shared/src/contracts.ts`;
this directory implements it and never modifies it.

**The rule this layer exists to enforce: no provider semantics above the Channel
interface.** Track D emits blocks and never learns whether delivery was blue, green or
grey. Every Linq noun — parts, protocols, trace ids, `Retry-After` — either stops at the
adapter or crosses in a field the frozen contract already names.

## Files

| File | Provider-aware? |
|---|---|
| `src/linq-channel.ts` | yes — the adapter, and the only place Linq vocabulary appears |
| `src/errors.ts` | no — typed errors Track D branches on |
| `src/rate-limiter.ts` | no — a sliding-window limiter that does not know who it is calling |

That split is checked, not asserted: `grep -rn 'linq' cloud/channel/src --include=*.ts -il`
matches `linq-channel.ts` and its test, and nothing else.

## Typed errors

Track D branches on these. `ChannelError.code` is a lowercase snake slug per
`CONTRACTS.md` § 6.

| Error | When | Carries |
|---|---|---|
| `LineBannedError` | `503 line_banned` | `lineId` |
| `RateLimitedError` | `429`, **or** this track's own limiter refusing | `retryAfterSeconds`, `local` |
| `UpstreamError` | 5xx, 401/403, malformed body, transport failure | `code`, `status`, `lineId` |
| `CapabilityError` | a send refused before the wire, e.g. a group send | `capability` |
| `EmptyMessageError` | every block degraded away | — |

`LineBannedError` is the one that matters. Platform uptime can read 100% while a shared
Apple ID is banned and every user on that line has a dead thread. It is a migration event,
never a retry — retrying a banned line is what deepens the ban.

`RateLimitedError.local` distinguishes our limiter from the provider's 429. Track D may
retry a local refusal against another line immediately; it must not do that with a remote
one.

## Capability negotiation, not assumption

`capabilities()` is consulted before every send, and `requested_capabilities` on the
message is deliberately **not** — it is advisory, and what the line can actually do is what
governs.

- `groups: false` → a multi-recipient send is **refused before the wire**. A group send
  that quietly fans out to individuals is a consent violation, not a formatting problem.
- `images: false`, `contact_cards: false` → those blocks are dropped and the rest sends.
- `threading: false` → `reply_to` is dropped and the message still sends.
- Every block dropped → `EmptyMessageError`. Degrade, never fabricate; an empty message is
  a fabrication of "we sent something".

Capabilities are **configuration, not discovery**: the Linq subset documents no
capabilities endpoint. Every value is a guess, which also means the sales-call answers land
in config rather than in a code change.

## Health

`GET /lines`'s shape is a guess (`CONTRACTS.md` § 11 item 8), so `parseHealth` reads
defensively across the envelopes a real API plausibly returns — `{lines:[…]}`, a bare
array, `{data:[…]}`, a single unwrapped object, `{line:{…}}` — and across `status` /
`state` / `health` keys with a vocabulary of synonyms.

**When it cannot understand the answer it reports `degraded`, never `up`.** Claiming a line
is healthy on the strength of a response we failed to parse is the confident-wrong-answer
failure the product rules forbid. Same for unreachable: not healthy, and not proven banned.

## Idempotency

`OutboundMessage.idempotency_key` is cached in process; a repeat returns the first
`SendResult` without a second request, and concurrent sends with one key collapse to a
single request. A **failed** send is not cached, so the retry is allowed through.

The limit worth knowing: this is in-process only. The Linq subset documents no idempotency
header, and sending one would be inventing wire format — the one thing this track must not
do. A retry after a process restart can therefore still double-send. That is a sales-call
question, recorded in `NOTES.md`, not something to paper over here.

## Rate limiting

Sliding window, not a token bucket — a bucket permits a full-size burst the instant it
refills, and burst is exactly the shape we are trying not to present.

| Variable | Default | |
|---|---|---|
| `CHANNEL_RATE_LIMIT_MAX` | `30` | permits per interval |
| `CHANNEL_RATE_LIMIT_INTERVAL_MS` | `60000` | |
| `CHANNEL_RATE_LIMIT_BEHAVIOUR` | `delay` | `delay` \| `reject` |

Conservative by design: 30/minute is far above one brief per user per day and far below
anything that reads as automation. Real limits are unknown (`CONTRACTS.md` § 11 item 3), so
the number lives in config and the answer lands there rather than in a diff.

## Configuration

| Variable | Default | |
|---|---|---|
| `LINQ_BASE_URL` | `http://localhost:3031/api/partner/v3` | **includes** the prefix; production is a one-value swap |
| `LINQ_API_TOKEN` | `""` | rep-provisioned; none exists yet |
| `LINQ_FROM_HANDLE` | `""` | the line's E.164 handle |
| `LINQ_LINE_ID` | `""` | fallback for `SendResult.line_id`; see NOTES.md |
| `CHANNEL_REQUEST_TIMEOUT_MS` | `10000` | |

## Two things the caller must supply

**A handle resolver.** `outbound.v1` carries `user_id` and no handle, and the schema is
closed, so the recipient cannot travel inside the message. Track D owns the users table and
injects `resolveHandles`. Recorded as a contract gap in `NOTES.md`.

```ts
new LinqChannel(loadLinqChannelConfig(), {
  resolveHandles: async (userId) => [await db.phoneFor(userId)],
});
```

**Nothing for inbound yet.** `normalizeInbound` throws `not_implemented`; it lands in
prompt 03. It throws rather than returning a plausible stub because the frozen contract says
it never returns a partially-normalized message, and a stub would let Track D build against
fabricated inbound without noticing until integration.

## Tests

```bash
npm test -- cloud/channel cloud/mock-linq
```

The suite runs the mock on a real socket at port **3032** (Track C's assigned channel test
port) rather than through `inject()`, because the thing under test is the adapter's HTTP
client — base URL, headers, body serialization. Testing it against an in-process fake would
prove nothing about the wire.
