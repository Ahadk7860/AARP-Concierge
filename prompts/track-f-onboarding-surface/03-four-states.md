# Track F — Prompt 03: the screen makes a claim it cannot support

**Depends on:** 02. Small, and likely this track's last before MVP.

## Context

`lineUnresolved` collapses two different situations and tells the user the same thing:

> "Boi will still text you — this window just cannot open the thread for you."

**True when paired.** The thread exists from signup; Boi is replying into it; only this
window's ability to open it is missing.

**False when unpaired.** There is no thread, the handle is not on the transport's
allowlist, and Boi cannot text them at all. The screen promises a message that will never
arrive, and the user waits instead of acting.

You identified this yourself and correctly scoped it here. Two facts, both knowable from
the token store, four states:

| paired | line known | what is true |
|---|---|---|
| yes | yes | "Open the conversation" — the button works |
| yes | no | the thread exists on their phone; Boi will text; this window cannot open it |
| no | yes | "Start the conversation" — deep link, prefilled body |
| **no** | **no** | **Boi cannot text them and they cannot text Boi.** Send them back to the signup link |

## Objective

Every state says only what it knows, and the one genuinely broken state offers a remedy
rather than reassurance.

## Scope

In: the four-way split in `ThreadHandoff.copy`, driven by the token store; a real remedy
for the unpaired-and-unresolvable case; tests per state.

Out: anything else. This is a correctness fix, not a redesign.

## Definition of Done

- [ ] Four states, four distinct copy paths, asserted separately
- [ ] **No state claims future contact it cannot support** — assert on the absence of the
      phrase, not on the presence of a better one
- [ ] The unpaired-and-unresolvable state names a remedy the user can act on
- [ ] The copy lives in `ThreadHandoff.copy`, importable and asserted — not in the
      executable target, per your own finding in `02`
- [ ] `swift test --package-path mac` and `bash scripts/gate.sh f` green
- [ ] Every criterion names the mutation that breaks it, shown red
