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
if [ -z "$LETTER" ]; then echo "usage: check-ownership.sh <a|b|c|d>" >&2; exit 2; fi

case "$LETTER" in
  a) OWNED='^mac/' ;;
  b) OWNED='^intelligence/' ;;
  c) OWNED='^cloud/(channel|mock-linq)/' ;;
  d) OWNED='^cloud/(api|brief|card|db)/' ;;
  *) echo "unknown track: $LETTER" >&2; exit 2 ;;
esac

# Foundation-owned, append-only. Every append must also be recorded in NOTES.md.
SHARED='^(package\.json|package-lock\.json|pnpm-lock\.yaml|pyproject\.toml|\.env\.example|\.gitignore|README\.md|scripts/|prompts/)'
OWN_NOTES="^prompts/track-${LETTER}-[a-z-]+/(NOTES\.md|TRACK\.md)$"

# Frozen by the foundation. Changing any of these is the highest-severity form of
# anchor-bending available here: it silently changes the surface every OTHER track is
# coding against, and nobody finds out until integration.
FROZEN='^(contracts/|prompts/(CONTRACTS|MERGE-POLICY|TRACK-REVIEW|WORKTREE-PROTOCOL)\.md$|cloud/shared/src/|intelligence/boi_intel/(contracts\.py|providers/fake\.py)$|mac/Sources/BoiKit/Contracts\.swift$)'

changed="$(git diff --name-only "$BASE"...HEAD || true)"

frozen_hits="$(echo "$changed" | grep -E "$FROZEN" || true)"
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
