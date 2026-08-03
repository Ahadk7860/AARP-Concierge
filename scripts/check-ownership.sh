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
if [ -z "$LETTER" ]; then echo "usage: check-ownership.sh <a|b|c|d|e>" >&2; exit 2; fi

case "$LETTER" in
  a) OWNED='^mac/' ;;
  b) OWNED='^intelligence/' ;;
  c) OWNED='^cloud/(channel|mock-linq)/' ;;
  d) OWNED='^cloud/(api|brief|card|db)/' ;;
  # Track E is the join. It owns two new cloud directories, the Spectrum channel, the
  # Mac's uploader, and NOTHING ELSE — including inside the files it is allowed to edit.
  # The narrow call-site edits in SyncRun.swift, main.swift, run.ts and compose.ts are
  # listed here by name because "may edit one line of" is not a thing a path regex can
  # express. Reviewing the diff of those four files by eye is part of the merge.
  e) OWNED='^(cloud/(intelligence-bridge|e2e)/|cloud/channel/src/spectrum-[a-z-]+\.ts$|cloud/channel/test/spectrum-[a-z-]+\.test\.ts$|mac/Sources/BoiKit/(Uploader|UploadQueue)\.swift$|mac/Tests/BoiKitTests/Uploader.*Tests\.swift$|mac/Sources/BoiKit/SyncRun\.swift$|mac/Sources/BoiCLI/main\.swift$|cloud/brief/src/(run|compose)\.ts$)' ;;
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
#
# The second is deliberately not narrowed to the union — a regex cannot tell a widened
# union from a deleted field. It is narrowed by review instead: the merge reads the diff.
ALLOWED_FROZEN='^(contracts/transcripts/spectrum/|cloud/shared/src/contracts\.ts$|contracts/schema/digest\.v1\.json$|contracts/fixtures/digest/|mac/Sources/BoiKit/Contracts\.swift$|intelligence/boi_intel/contracts\.py$)'

# Prompt 03 (AMENDMENT-001) additionally lets Track E edit the gist producer and the two
# checkers, which belong to Tracks A and B. Those tracks have merged and stopped, and the
# amendment names these files explicitly. Not frozen, just not normally track E's.
AMENDMENT_001='^(mac/Sources/BoiKit/(DigestBuilder|Fact[A-Za-z]*)\.swift$|mac/Tests/BoiKitTests/(Digest|Fact[A-Za-z]*)Tests\.swift$|intelligence/boi_intel/(gist|threads)\.py$|intelligence/tests/test_(gist|threads|facts)\.py$|scripts/(check_voice_pack_leak|validate_fixtures)\.py$|cloud/api/src/(schemas\.ts|schemas\.test\.ts|differential\.test\.ts)$)'

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
  if [ "$LETTER" = "e" ] && echo "$f" | grep -Eq "$AMENDMENT_001"; then
    echo "AMENDMENT-001 (another track's file, granted by the amendment): $f"
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
