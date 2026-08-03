# Track E — launch

You are the fifth and final track on the Boi project. Your repo is `~/Dev/boi-imessage`.

Four tracks — the Mac sensor, the intelligence, the transport, the cloud surface — were
built in parallel in separate worktrees and have all merged to `main`. There are roughly
a thousand tests across four toolchains and they are all green.

**The product has never been run.** Not once, end to end. Four tracks each built a working
half of a pipe against frozen contracts and fixtures, and the seams between them have
never carried real data. That is your entire job.

## Read these, in this order, before you write anything

1. `prompts/track-e-the-join/TRACK.md` — what you own, the four gaps, and the anchor
2. `prompts/CONTRACTS.md` — the shared surface. Long. Read it anyway.
3. `prompts/TRACK-REVIEW.md` — how you report
4. `prompts/MERGE-POLICY.md`

`prompts/WORKTREE-PROTOCOL.md` is mostly not yours: **you do not get a worktree.** Every
other track has merged, so there is nobody to conflict with. Work on a branch:

```bash
cd ~/Dev/boi-imessage
git checkout main && git pull
git checkout -b track-e
```

Do not read `~/Documents/Claude/boi-imessage/01-strategy/SPECTRUM_INTEGRATION.md` until
prompt `04`. It describes a transport you must not reach for before the pipe is green
against the stub.

## How to run

Prompts live in `prompts/track-e-the-join/`. Take them in this batching:

| Batch | Prompts | Why |
|---|---|---|
| 1 | `01` **and** `02` | No dependency edge between them. Different languages, different directories. |
| 2 | `03` | Depends on both. |
| 3 | `04` | Depends on `03` being green **and** on a human having read its artifacts. |

Within a batch, one prompt at a time: one prompt, one commit, one gate. Batching means
you do not stop for review between `01` and `02` — it does not mean you interleave them.

After **every** prompt, batched or not:

```bash
bash scripts/gate.sh e
```

Red gate: stop. Do not start the next prompt, do not fix it in the next prompt. Commit
what works with the failure named in the message, write it into `NOTES.md`, and report.

## The rules that matter most here

**A join that passes because both sides were stubbed is not a join.** Every criterion
must be satisfiable only by data that actually crossed a process boundary. If a test
passes with the Python interpreter uninstalled, it is not testing the intelligence
bridge.

**You are wiring, not fixing.** When Track B emits something Track D did not expect, the
correct action is not to edit Track B. It is to write down exactly what disagreed, both
sides quoted, in `NOTES.md`, and then adapt in *your* bridge. Editing another track's
merged code to make your test pass destroys the finding, which is worth more than the fix.
`scripts/check-ownership.sh e` will stop you, but it should never have to.

**Two frozen files are sanctioned for you and only in prompt `04`:**
`contracts/transcripts/spectrum/` and one union widening in `cloud/shared/src/contracts.ts`.
The ownership script announces them on every run rather than waving them through. Anything
else frozen is still frozen.

**Report a green checklist only when it is true.** A criterion bought by weakening a check
is a failure reported as a success — and this repo has a specific history of it: a track
once reported a passing typecheck for a suite that could not compile, with 29 of 29 tests
silently skipped. `gate.sh` exists because of that. Do not route around it.

## Stop and ask the human when

- A prompt needs a running API server, a database, or a `GEMINI_API_KEY` you do not have
- `04` reaches the live send. **Never send a real message without explicit confirmation**
- You believe a prompt's stated assumption about the codebase is wrong. Say so; do not
  quietly build to the corrected assumption

## Now

Read the four documents. Then confirm back, in a few sentences: what the four gaps are,
which two prompts you are about to run, and anything in `01` or `02` you think is wrong.

Then start `01`.
