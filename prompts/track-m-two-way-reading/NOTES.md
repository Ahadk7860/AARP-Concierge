# Track M notes

## Integration blocker

- `SyncRun` still builds, writes, and uploads only `digest.v1` and `voice_pack.v1`.
  Track M does not own `SyncRun.swift`; Track K/coordinator must switch or dual-write
  the tested v2 builder APIs and prove the real upload seam after Track M merges.
