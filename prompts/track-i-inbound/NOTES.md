# Track I — inbound stream

## Prompt 01 evidence

- `npm run typecheck` passed.
- `npx vitest run cloud/channel/test/spectrum-stream.test.ts` passed (4 tests).
- The stream adapter remains injected because the Photon stream SDK surface is unverified.
- The wrapper only owns lifecycle and deduplication; persistence and routing remain out of scope.

## Contract gaps

None. The eventual Photon adapter must translate its documented event id and monotonic cursor
into `SpectrumStreamEvent` without logging payload text.
