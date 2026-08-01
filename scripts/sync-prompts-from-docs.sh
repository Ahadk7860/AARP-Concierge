#!/usr/bin/env bash
set -euo pipefail

# Optional. Only if you prefer to EDIT prompts in Documents alongside the strategy
# docs rather than in the repo.
#
# The repo copy stays canonical, because that is what pins each track to the plan it
# started against. This script moves your edits in one direction only:
#
#     Documents  ->  repo base branch  ->  (you commit)  ->  (you forward-merge into tracks)
#
# Run it on the base branch, from the main clone, never from inside a worktree.
# Then follow the contract-amendment procedure in prompts/WORKTREE-PROTOCOL.md:
# amending the plan under a running track is exactly the change parallel agents
# cannot absorb quietly.

DOCS="${BOI_DOCS_PROMPTS:-$HOME/Documents/Claude/boi-imessage/06-prompts}"

git_dir=$(git rev-parse --git-dir)
if [ "$(basename "$(dirname "$git_dir")")" = "worktrees" ]; then
  echo "You are inside a linked worktree. Run this from the main clone." >&2
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"

if [ ! -d "$DOCS" ]; then
  echo "no prompts folder at $DOCS" >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  echo "You are on '$branch'. Sync onto the base branch, then forward-merge." >&2
  exit 1
fi

rsync -av --delete \
  --exclude 'NOTES.md' \
  "$DOCS"/ prompts/

echo
echo "NOTES.md files were left alone -- those are written by the agents, not by you."
git status --short prompts/
echo
echo "Review the diff, then:"
echo "  git add prompts/ && git commit -m 'contracts: amend the plan' && git push"
echo "  then, per track: git merge main   (never rebase)"
