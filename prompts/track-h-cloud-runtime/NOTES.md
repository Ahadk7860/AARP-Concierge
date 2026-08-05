# Track H — Prompt 01 evidence

- `npm run typecheck` passed.
- `npx vitest run cloud/api/src/main.test.ts` passed (16 tests after review fixes).
- `bash scripts/check-ownership.sh h` passes after the commit.

## Prompt 01 review fixes

- The validated database URL, four Spectrum settings, and handle-envelope master key
  now cross explicit dependency-factory boundaries; focused tests capture every value.
- Startup and shutdown use a cleanup stack. All acquired resources receive a close
  attempt even when a later acquisition, listener, or closer fails; the first/primary
  failure is retained.
- Database and Spectrum readiness checks run concurrently with a configurable bounded
  timeout and expose/log component slugs only.
- The handle-envelope master key is consumed by an injected runtime key-provider
  capability for Track I; this track still does not implement private-row storage.
- The runtime-created Postgres pool is installed before API construction. A repository-
  backed authenticated request, readiness query, and shutdown all prove they observe
  that exact object; the production secret matrix removes every currently required
  secret independently and fails closed.

## Deferred integration facts

- This prompt composes the existing live Spectrum SDK adapter behind its injected
  interface. It does not open a Photon connection during tests or deploy.
- `channel_space_id` is an existing migration (`011_channel_space.sql`); deployment
  migration execution and platform-secret provisioning remain later Track H work.
