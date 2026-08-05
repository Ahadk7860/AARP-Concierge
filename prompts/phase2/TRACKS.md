# Phase 2 Ownership

| Track | Owned outcome | Green against |
|---|---|---|
| G | signed app artifact and measured four scheduled wakes | local app/wake tests; release dry-run |
| H | API/card process entrypoints and deploy wiring | health endpoint and migration dry-run |
| M | on-device two-way understanding and contextual voice packs | v2 fixtures and no-verbatim mutations |
| I | Spectrum stream, encrypted inbound turns, tap-to-send delivery | recorded stream fixtures and absent-handle fixture |
| J | closed `waiting_on_me` chat and fabrication eval | frozen chat fixtures plus 50-question eval |
| K | real-system install and seam audit | real endpoint, real stream, real app |

Resource collisions: only H touches deployment secrets/platforms; only G invokes Apple
signing; only I runs a stream listener; only K may conduct the full end-to-end run.
