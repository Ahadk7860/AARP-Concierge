# Amendment 003 — a heartbeat may precede the first digest

**Author:** the planning session. **Date:** 4 Aug. **Status:** approved, unimplemented.
**Amends:** `contracts/openapi/boi-api.v1.yaml` (`POST /v1/heartbeat`), the zod mirror.
**Found by:** Track F, before writing any code.

## What was found

`POST /v1/heartbeat` requires `[device_id, app_version, digest_as_of]` with
`additionalProperties: false`. **At the moment Full Disk Access is granted, no sync has
ever run, so there is no `digest_as_of`.**

The schema encodes an assumption nobody stated: *a heartbeat always follows a digest.*
Under AMENDMENT-002 the grant heartbeat by definition precedes the first one.

Track E had already reasoned to the edge of this and stopped in the right place. Its
`HeartbeatUpload.from` comment says falling back to a current timestamp *"would report a
Mac that produced nothing as having produced something now."* That is correct, and it is
why the fix is not a default value.

## The candidate fixes

**Fabricate a timestamp.** Rejected, for Track E's reason. It makes a never-synced Mac
indistinguishable from a freshly-synced one in the one dataset used to detect fleet-wide
failure — which is the exact query the field exists to serve.

**A separate pre-sync device-state endpoint.** Rejected. It splits device liveness across
two tables and two shapes, and the fleet-health query then has to union them. The
information is the same information.

**Make `digest_as_of` nullable, meaning "has never produced a digest."** Chosen.

## The delta

`digest_as_of` becomes `["string", "null"]`, still required. **Required-and-nullable, not
optional** — the field must always be present, so a producer that omits it is still
rejected. `null` is a claim ("this device has never synced"), not an absence ("I forgot").

This is a widening: every document that validates today still validates.

## Why this is better than a workaround

`granted, never synced` becomes a **first-class, queryable state**, and it is one of the
most diagnostic states the fleet has. A Mac that has FDA and has never produced a digest
is a broken sync — which is a different alarm from a quiet Mac, and today it is invisible.

The fleet query gains a bucket. `CONTRACTS.md` § 10 hole 8 asks for the fleet-wide
heartbeat alarm; this makes it strictly better at its job.

## What this does not change

`device_id` is unaffected. Track E established that `/v1/pair` accepts a client-supplied
`device_id`, so the Mac's derived `dev_…` is the one registered — the Mac can populate it
without a round trip.

The device **token** is a separate matter and is resolved by AMENDMENT-002's ordering:
pairing now happens in the iMessage thread *before* the app is installed, so by the time
FDA is granted the device is already paired. Track F should keep `DeviceIdentity`
injected — that seam is correct regardless, and it is what lets this amendment change one
call site rather than a design.

## Implementation

Track E, in prompt `08` (it already owns the schema mirror and the ingest route). Track F
codes against the injected identity and does not wait.
