#!/usr/bin/env bash
# Assert every path this branch touched belongs to this track.
#
#   bash scripts/check-ownership.sh a
#
# Uses `git diff --name-only <base>...HEAD`, not `git status`. After the mandated
# per-prompt commit `git status` is empty and the check would pass silently, leaving
# the entire ownership model unguarded.
set -euo pipefail

LETTER="${1:-}"
BASE="${BOI_BASE:-main}"
if [ -z "$LETTER" ]; then echo "usage: check-ownership.sh <a|b|c|d|e|f>" >&2; exit 2; fi

case "$LETTER" in
  a) OWNED='^mac/' ;;
  b) OWNED='^intelligence/' ;;
  c) OWNED='^cloud/(channel|mock-linq)/' ;;
  d) OWNED='^cloud/(api|brief|card|db)/' ;;
  # Track E is the join. It owns its own cloud directories (intelligence-bridge, e2e,
  # and — from prompt 07 — scheduler), the Spectrum channel, the Mac's uploader, and
  # NOTHING ELSE — including inside the files it is allowed to edit.
  #
  # `cloud/card/` is Track D's and is granted from prompt 05: the card has to become
  # hosted, authenticated and deletable, and that lives in the renderer's own service.
  # Redesigning the card is still out of scope; the merge reads this diff.
  # The narrow call-site edits in SyncRun.swift, main.swift, run.ts and compose.ts are
  # listed here by name because "may edit one line of" is not a thing a path regex can
  # express. Reviewing the diff of those four files by eye is part of the merge.
  e) OWNED='^(cloud/(intelligence-bridge|e2e|scheduler)/|cloud/card/|cloud/channel/src/spectrum-[a-z-]+\.ts$|cloud/channel/test/spectrum-[a-z-]+\.test\.ts$|mac/Sources/BoiKit/(Uploader|UploadQueue)\.swift$|mac/Tests/BoiKitTests/Uploader.*Tests\.swift$|mac/Sources/BoiKit/SyncRun\.swift$|mac/Sources/BoiCLI/main\.swift$|cloud/brief/src/(run|compose|deliver)\.ts$)' ;;
  # Track F — the onboarding surface. Disjoint from E by construction: E owns BoiCLI,
  # SyncRun and the uploader; F owns the app target and one new BoiKit file. F may CALL
  # Uploader and GrantWatcher and may not modify them, which a path regex cannot express
  # — it is enforced by reading the diff at merge.
  f) OWNED='^(mac/Sources/BoiApp/|mac/Sources/BoiKit/GrantNarrator\.swift$|mac/Tests/BoiKitTests/(GrantNarrator|Onboarding)Tests\.swift$)' ;;
  *) echo "unknown track: $LETTER" >&2; exit 2 ;;
esac

# Foundation-owned, append-only. Every append must also be recorded in NOTES.md.
SHARED='^(package\.json|package-lock\.json|pnpm-lock\.yaml|pyproject\.toml|\.env\.example|\.gitignore|README\.md|scripts/|prompts/)'
OWN_NOTES="^prompts/track-${LETTER}-[a-z-]+/(NOTES\.md|TRACK\.md)$"

# Frozen by the foundation. Changing any of these is the highest-severity form of
# anchor-bending available here: it silently changes the surface every OTHER track is
# coding against, and nobody finds out until integration.
FROZEN='^(contracts/|prompts/(CONTRACTS|MERGE-POLICY|TRACK-REVIEW|WORKTREE-PROTOCOL)\.md$|cloud/shared/src/|intelligence/boi_intel/(contracts\.py|providers/fake\.py)$|mac/Sources/BoiKit/Contracts\.swift$)'

# Track E, and only track E, has two sanctioned exceptions to FROZEN. They are granted
# because all four parallel tracks have merged, so "the surface every other track is
# coding against right now" no longer describes anyone. They are still announced on
# every run — a sanctioned exception that prints nothing becomes an unguarded path.
#
#   contracts/transcripts/spectrum/   additive; a new vendor's recorded fixtures
#   cloud/shared/src/contracts.ts     ONE union widening: provider gains "spectrum"
#   contracts/schema/brief.v1.json    prompt 05: card_kind, additive
#   contracts/schema/draft_bundle.v1.json
#                                     prompt 06: validator.failures gains
#                                     `stale_tense_gate`. A UNION WIDENING -- every
#                                     document that validates today still validates.
#   prompts/CONTRACTS.md              prompt 06: APPEND-ONLY, and the appends are rules
#                                     that were lost between the architecture and this
#                                     file -- which is why four merged tracks could not
#                                     have built them. Granted by prompt 06 by name.
#
# The second is deliberately not narrowed to the union — a regex cannot tell a widened
# union from a deleted field. It is narrowed by review instead: the merge reads the diff.
ALLOWED_FROZEN='^(prompts/CONTRACTS\.md$|contracts/transcripts/spectrum/|cloud/shared/src/contracts\.ts$|contracts/schema/(digest|brief|draft_bundle)\.v1\.json$|contracts/fixtures/digest/|mac/Sources/BoiKit/Contracts\.swift$|intelligence/boi_intel/contracts\.py$)'

# AMENDMENT-003 — prompt 08, the nullable `digest_as_of`. Its own variable, same reason
# as 002: a grant appended to a neighbouring line can be lost to a concurrent edit with
# no conflict and no error, and the gate then goes green because the rule that would have
# failed was removed from the gate.
#
# This is the FIRST grant against contracts/openapi/. The schema files were named
# individually in ALLOWED_FROZEN and the OpenAPI document was not — an omission, not a
# decision. Track F found the contract gap; track E found the missing grant before
# hitting it.
AMENDMENT_003='^contracts/openapi/boi-api\.v1\.yaml$'

# AMENDMENT-002 — prompts 08 and 09, the onboarding inversion. Kept as its OWN variable
# rather than appended to AMENDMENT_001, because a grant added to a shared line can be
# lost when two authors edit that line concurrently. That is exactly what happened here:
# `welcome.ts` was granted by the reviewer, track E extended the same line for its own
# grants, and the reviewer's addition disappeared with no conflict and no error.
AMENDMENT_002='^(cloud/api/src/welcome\.ts$|cloud/api/src/welcome\.test\.ts$|cloud/brief/src/inbound\.ts$|cloud/brief/src/inbound\.test\.ts$)'

# Prompt 03 (AMENDMENT-001) additionally lets Track E edit the gist producer and the two
# checkers, which belong to Tracks A and B. Those tracks have merged and stopped, and the
# amendment names these files explicitly. Not frozen, just not normally track E's.
AMENDMENT_001='^(mac/Sources/BoiKit/(DigestBuilder|Fact[A-Za-z]*)\.swift$|mac/Tests/BoiKitTests/(Digest|Fact[A-Za-z]*)Tests\.swift$|intelligence/boi_intel/(gist|threads)\.py$|intelligence/tests/test_(gist|threads|facts)\.py$|scripts/(check_voice_pack_leak|validate_fixtures)\.py$|cloud/api/src/(schemas\.ts|schemas\.test\.ts|differential\.test\.ts|signup\.test\.ts|routes/signup\.ts)$|cloud/db/src/repository\.ts$|intelligence/boi_intel/(prompts|validator)\.py$|intelligence/tests/test_(prompts|validator|draft)\.py$|scripts/make_synthetic_chatdb\.py$)'

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "cannot resolve base ref '$BASE' — refusing to report a pass I cannot justify" >&2
  exit 2
fi
changed="$(git diff --name-only "$BASE"...HEAD)"

frozen_hits="$(echo "$changed" | grep -E "$FROZEN" || true)"
if [ "$LETTER" = "e" ] && [ -n "$frozen_hits" ]; then
  sanctioned="$(echo "$frozen_hits" | grep -E "$ALLOWED_FROZEN" || true)"
  frozen_hits="$(echo "$frozen_hits" | grep -Ev "$ALLOWED_FROZEN" || true)"
  if [ -n "$sanctioned" ]; then
    echo "FROZEN, SANCTIONED FOR TRACK E — must be in NOTES.md and read line-by-line at merge:"
    echo "$sanctioned" | sed 's/^/  /'
    echo
  fi
fi
if [ -n "$frozen_hits" ]; then
  echo "FROZEN FILE MODIFIED:"
  echo "$frozen_hits" | sed 's/^/  /'
  echo
  echo "These are the shared surface every other track is coding against right now."
  echo "Revert them, record the problem in NOTES.md under '## Contract gaps', and"
  echo "report. The user amends contracts; a track never does."
  exit 1
fi
if [ -z "$changed" ]; then echo "no changes vs $BASE"; exit 0; fi

bad=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if echo "$f" | grep -Eq "$OWNED"; then continue; fi
  if echo "$f" | grep -Eq "$OWN_NOTES"; then continue; fi
  # The sanctioned-frozen files were announced by the FROZEN block above and then fell
  # through to OUT OF BOUNDS here, because announcing is not the same as permitting.
  # That made every sanctioned exception unusable — including the two for prompt 05,
  # which had not been reached yet.
  if [ "$LETTER" = "e" ] && echo "$f" | grep -Eq "$ALLOWED_FROZEN"; then continue; fi
  if [ "$LETTER" = "e" ] && echo "$f" | grep -Eq "$AMENDMENT_001"; then
    echo "AMENDMENT-001 (another track's file, granted by the amendment): $f"
    continue
  fi
  if [ "$LETTER" = "e" ] && echo "$f" | grep -Eq "$AMENDMENT_002"; then
    echo "AMENDMENT-002 (onboarding surface, granted by the amendment): $f"
    continue
  fi
  if [ "$LETTER" = "e" ] && echo "$f" | grep -Eq "$AMENDMENT_003"; then
    echo "AMENDMENT-003 (FROZEN OpenAPI, granted by the amendment — read this diff at merge): $f"
    continue
  fi
  if echo "$f" | grep -Eq "$SHARED"; then
    echo "SHARED (append-only, must be recorded in NOTES.md): $f"
    continue
  fi
  echo "OUT OF BOUNDS: $f"
  bad=1
done <<< "$changed"

if [ "$bad" -ne 0 ]; then
  echo
  echo "Track $LETTER touched a path it does not own. Do not resolve this yourself:"
  echo "commit, record it in NOTES.md, and report. Another track may have work in"
  echo "flight against that file."
  exit 1
fi
echo "OK — ownership holds for track $LETTER"
