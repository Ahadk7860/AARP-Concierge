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

## Prompt 02 evidence — Railway packaging

- `npm run typecheck` passed.
- `npx vitest run cloud/api/src/main.test.ts cloud/api/src/main-deploy.test.ts
  cloud/db/src/deploy.test.ts` passed (32 tests).
- Focused ESLint, emitted-JavaScript process selection, `git diff --check`, and Track H
  ownership passed.
- Both Railway services build from the monorepo root and one Dockerfile. `BOI_PROCESS`
  selects API or card; there is deliberately no default process.
- Pre-deploy migrations use a session-level Postgres advisory lock. Tests prove two
  simultaneous service deploys never enter the migration runner together, and failure
  still unlocks/releases while retaining the migration error.
- Hosted cards bind `0.0.0.0:${PORT}`, fail closed on signing/write/public-base/volume
  config, publish `/healthz`, and require the Railway volume mount to equal the card root.

## Residual live gates

- No Railway account, project, service, Postgres, volume, domain, or variable was created.
- The user must authorize Railway, create two services plus Postgres, attach the card
  volume, and add secrets privately before the first deploy.
- Live acceptance still requires terminal-success deploys, TLS/health probes, migration
  logs, persistence across a card-service redeploy, and a synthetic Spectrum send.
