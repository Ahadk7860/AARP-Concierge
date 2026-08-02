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
| `src/inbound.ts` | no — signature verification and `inbound.v1` assembly |
| `src/line-registry.ts` | no — who is on which line, and who just lost their thread |
| `src/line-health.ts` | no — health transitions and `line.health_changed` |
| `src/routed-channel.ts` | no — sticky routing, automatic downgrade, re-introduction |

That split is checked, not asserted: of the non-test sources,
`grep -rn 'linq' cloud/channel/src --include=*.ts -il` matches **only**
`linq-channel.ts`. The two test files match, which is expected — they test the Linq
adapter.

## Typed errors

Track D branches on these. `ChannelError.code` is a lowercase snake slug per
`CONTRACTS.md` § 6.

**Branch on `code` and `retryable`. Never on `diagnostic`.** `code` is a closed union of
provider-neutral slugs, so `tsc` rejects a vendor string there. `diagnostic` carries the
provider's own slug and HTTP status for logs only — the moment that reaches a conditional
in Track D, a Linq string is in Track D's control flow and changes when a vendor we cannot
see edits a response body.

| Error | `code` | `retryable` | When |
|---|---|---|---|
| `LineBannedError` | `line_banned` | **false** | any error slug that parses as a ban |
| `LineUnavailableError` | `line_unavailable` | **false** | a 503 we cannot classify |
| `RateLimitedError` | `rate_limited` | true, after `retryAfterSeconds` | `429`, or our own limiter |
| `UpstreamError` | `unauthorized` | false | 401/403 |
| `UpstreamError` | `provider_unavailable` | true on 5xx | platform failure |
| `UpstreamError` | `malformed_response` | false | unparseable or unrecognized body |
| `UpstreamError` | `transport` | true | connection failed — **outcome ambiguous**, see idempotency |
| `UpstreamError` | `no_recipient` | false | the resolver returned nothing |
| `CapabilityError` | `unsupported_capability` | false | refused before the wire, e.g. a group send |
| `EmptyMessageError` | `empty_message` | false | every block degraded away |

Ban detection is **tolerant**, matching `health()`: any slug containing a token in
`{banned, blocked, suspended, disabled, terminated}` raises `LineBannedError`. Exact
equality against `"line_banned"` would let `account_suspended` fall through to a generic
retryable error — and the one body we have ever seen is a reconstruction.

A 503 we cannot classify raises `LineUnavailableError`, not `LineBannedError` and not a
retryable error. It might be a ban: too little evidence to trigger a migration, far too
much to retry. Consult `health()`.

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
capabilities endpoint. Override with `CHANNEL_CAPABILITIES="groups=1,threading=0"`; an
unknown key or unparseable value throws rather than being silently ignored.

**Only four of the seven gate anything.** `groups`, `images`, `contact_cards` and
`threading` do what is described above. **`tapbacks`, `richlinks` and `typing` gate no code
path anywhere in this repo** — no outbound block produces them and nothing reads them. They
exist because the frozen `Capabilities` type has those fields. "Negotiated before use" is
vacuous for those three until something uses them, and it is written down here rather than
left to look green.

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

`RoutedChannel` keys **independently**, and must: routing to the fallback on a `degradeOn`
line never consults the primary's cache at all, so without keying at the routing layer,
`send(K)` → line goes banned → retry `K` texts the user twice, in one process, with no
restart involved. Track D holds `RoutedChannel`, so that is the layer that has to be right.

**Three limits worth knowing, all of which can double-text a user.** The DoD this satisfies
is "one request reached the mock"; it is not "the user was not texted twice".

1. **The cache is an in-memory `Map` on the instance.** It dies with the process and is not
   shared between instances or replicas. Two workers, or one worker after a restart, will
   send twice for one key.
2. **The ambiguous outcome is not covered.** If the connection dies after the provider
   accepted the message, the adapter raises `UpstreamError` with code `transport` and does
   not cache — deliberately, since a failure that never reached the provider must be
   retryable. But a timeout cannot distinguish those two cases, so a caller that retries
   double-texts.

3. **Nothing above `RoutedChannel` is covered.** Both caches are in-process maps. Two
   replicas, or a queue worker that restarts mid-brief, still double-send.

Neither of the first two is fixable inside this track: the Linq subset documents no
idempotency header, and inventing one would be inventing wire format.

> **Track D: durable idempotency belongs ABOVE `RoutedChannel`.** A persisted
> `(user_id, idempotency_key) → message_id` written before the send and settled after is
> the only thing that survives a restart or spans replicas. The in-process caches here are
> a floor, not the guarantee.

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
| `CHANNEL_CAPABILITIES` | `""` | `key=bool` pairs; unknown key or bad value throws |

All of these are in `.env.example`.

## Inbound

`normalizeInbound(rawBody, signature)` verifies **before** it parses. An unverified body is
attacker-controlled input, and any line that interprets it before the signature is checked
is a line running on somebody else's data.

- **Raw bytes only.** Pass exactly what arrived — a string, a `Buffer`, a `Uint8Array`. An
  already-parsed object is refused, because re-serializing it to check a signature compares
  against bytes that were never on the wire. Key order and whitespace normalize away, so
  that bug passes every test written the same wrong way and fails on the first real
  webhook.
- **Constant-time comparison**, `crypto.timingSafeEqual`. An early-returning compare leaks
  how much of a forged signature was right, which is enough to build a valid one a byte at
  a time.
- **Three distinct errors, on purpose.** `SignatureError` (`bad_signature`) is a security
  event. `InboundParseError` (`malformed_inbound`) is schema drift. `RawBodyRequiredError`
  (`raw_body_required`) is a caller bug — you passed a parsed object. Collapsing any two
  means neither gets the response it deserves, and the worst collapse is a config bug
  arriving as a forged-signature alert, which trains people to ignore the alert.

> **Callers on Fastify:** register a raw-body content-type parser *ahead of* the JSON
> parser and pass `req.rawBody`. With Fastify's default you get a parsed object, every
> webhook throws `RawBodyRequiredError`, and it looks like a signature problem.
- **Swappable verifier.** The real scheme is unconfirmed (`CONTRACTS.md` § 11 item 2), so
  it is an injected strategy: `new LinqChannel(config, { verifier })`.
- **A missing or duplicated header is a `SignatureError`, never a crash.** `signature` is
  typed `string | string[] | undefined` — what `req.headers[...]` actually yields — so an
  unsigned webhook becomes `401 bad_signature` per `CONTRACTS.md` § 2 rather than a 500. A
  repeated header is rejected too: picking one of two values at a security boundary is
  guessing.
- **Unknown `type` is refused, never defaulted to `text`.** Defaulting would turn a read
  receipt into a message with null text, and Track D would treat provider noise as
  something a person said.
- **`user_id` is null** unless a `resolveUser` resolver is injected. Pairing owns that
  mapping and pairing is Track D's; an unknown handle is a normal state, not an error.

## Two things the caller must supply

**A handle resolver.** `outbound.v1` carries `user_id` and no handle, and the schema is
closed, so the recipient cannot travel inside the message. Track D owns the users table and
injects `resolveHandles`. Recorded as a contract gap in `NOTES.md`.

```ts
new LinqChannel(loadLinqChannelConfig(), {
  resolveHandles: async (userId) => [await db.phoneFor(userId)],
});
```

**A user resolver, if you want `user_id` populated.** `normalizeInbound` sets `user_id`
to null unless `resolveUser(handle)` is injected, which `inbound.v1` explicitly allows.

```ts
new LinqChannel(loadLinqChannelConfig(), {
  resolveHandles: async (userId) => [await db.phoneFor(userId)],
  resolveUser: (handle) => db.userForHandle(handle),   // optional
});
```

## Lines: assignment, health, downgrade

A user's line changing is a **retention event dressed up as an infrastructure event** —
their history is gone from their phone and Boi arrives as an unknown sender. And because
lines are shared, one ban takes out every user on it simultaneously.

**The blast-radius query.** `registry.usersOn(line_id)` returns every affected user in one
call. This is the question you need answered in the first minute of a ban; needing to write
a script for it means answering it an hour late.

**Sticky assignment.** `assign()` returns the existing line untouched, so calling it on
every send is what *enforces* stickiness rather than merely intending it. Lines fill to
`LINE_USERS_PER_LINE` before a new one is allocated, and the registry **refuses** to
over-pack rather than quietly exceeding tenancy — ban risk is super-linear in users per
line, so silently adding one more is precisely the wrong degradation.

**`line.health_changed` fires on a transition, never on a poll.** A poller that emits every
cycle produces a stream nobody can alert on: "banned" arriving every thirty seconds is
indistinguishable from a line that just went down. Consumers are entitled to assume each
event is news. Payload is exactly `CONTRACTS.md` § 4: `{ line_id, from, to, at }`.

**Automatic downgrade — green and late beats blue and never.** An unhealthy line sends over
the fallback *in the same call*, not via a retry queue. A brief that arrives tomorrow is not
a brief. `SendResult.provider` records which path was taken, and `routes` carries the
richer record.

The rule is one line of code — `DOWNGRADE_ON_CODES` — and it is **only** `line_banned` and
`line_unavailable`. A rate limit is our own throttling, a malformed response is our bug, a
500 is the platform: burning the fallback on any of those spends a second provider's quota
to hide a signal we need. Asserted class by class.

A known-banned line gets **no** doomed attempt first, because retrying a banned line is what
deepens the ban.

**Re-introduction on rotation — and never on first contact.** The first message from a
*new* line leads with "this is Boi, texting from a new number", exactly once per
(user, line). A **first-ever** assignment is marked introduced immediately and gets no
preamble: there was no previous conversation and no previous number, so saying "same
conversation, new bubbles" would be a false statement about the user's own history in the
product's voice — and Track D already sends a genuine first-contact message with a contact
card, which this would land on top of. Arriving from a new number and
resuming mid-conversation reads as a stranger who somehow knows you. The mark is committed
**after** a successful send — marking before would let a failed send burn the introduction
and leave a user permanently un-introduced.

**Metrics.** `registry.metrics()` gives users-per-line, capacity and current health for
every line, so blast radius is visible before an incident rather than computed during one.

### The fallback is a stub

It is any `Channel`. Track D wires the real one. Linq's own RCS/SMS fallback covers
per-message degradation, so this layer is business continuity, not a per-message path — the
Twilio adapter is a later round.

### State is in-process

`snapshot()` / `restore()` define what Track D persists. Losing this on restart would
re-introduce every user, which is a user-visible bug, not just a cache miss.

## Tests

```bash
npm test -- cloud/channel cloud/mock-linq
```

The suite runs the mock on a real socket at port **3032** (Track C's assigned channel test
port) rather than through `inject()`, because the thing under test is the adapter's HTTP
client — base URL, headers, body serialization. Testing it against an in-process fake would
prove nothing about the wire.
