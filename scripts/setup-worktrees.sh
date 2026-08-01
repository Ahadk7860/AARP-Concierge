#!/usr/bin/env bash
set -euo pipefail

# Portable to bash 3.2 (macOS default). No bash-4 features.

BASE="main"
ROOT="/Users/skylerluk/Dev"
PROJECT="boi-imessage"

# Must run from the MAIN clone, not from inside a worktree -- otherwise the checkout
# below lands in a track worktree or fails because BASE is checked out elsewhere.
git_dir=$(git rev-parse --git-dir)
if [ "$(basename "$(dirname "$git_dir")")" = "worktrees" ]; then
  echo "You are inside a linked worktree. Run this from the main clone." >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

git checkout "$BASE"
git pull --ff-only 2>/dev/null || echo "no upstream to pull from; continuing"

mkdir -p "$ROOT"

# Clear registrations whose directory was deleted by hand, so re-runs can reattach.
git worktree prune

create () {  # create <letter> <slug>
  letter="$1"; slug="$2"
  dir="$ROOT/$PROJECT-track-$letter"
  branch="track-$letter-$slug"

  if [ -d "$dir" ]; then
    echo "worktree exists, skipping: $dir"
  elif git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "branch $branch exists; reattaching worktree at $dir"
    git worktree add "$dir" "$branch"
  else
    git worktree add "$dir" -b "$branch"
  fi

  echo "Track $(printf '%s' "$letter" | tr '[:lower:]' '[:upper:]'): open a session in $dir"
}

create a "mac"
create b "intelligence"
create c "transport"
create d "cloud-surface"

echo
git worktree list
echo
echo "Next: follow prompts/LAUNCH.md, one session per track."
