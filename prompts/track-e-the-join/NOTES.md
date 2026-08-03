# Track E — notes

Record here: every append to a shared file, every dependency added, every contract
ambiguity found, and every place a prompt's stated assumption turned out to be wrong.

## Shared-file appends

| Prompt | File | What | Why it could not be track-local |
|---|---|---|---|

## Contract ambiguities found

The point of this track is to find these. An empty section here after four prompts is
itself a finding — it means the join was tested against fixtures again.

| Prompt | Where | What disagreed |
|---|---|---|

## Open

- `SendResult.protocol` is `"imessage" | "rcs" | "sms"`. Spectrum reports
  `"iMessage" | "SMS" | "RCS" | "unknown"`. Decide what `"unknown"` becomes — see `04`.
