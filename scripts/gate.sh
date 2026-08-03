#!/usr/bin/env bash
# The gate between prompts. Run it after EVERY prompt, batched or not.
#
#     bash scripts/gate.sh <a|b|c|d|e>
#
# Exits non-zero if anything is red. A track running a batch of prompts stops at the
# first non-zero gate and reports -- it does not continue and it does not "fix it in
# the next prompt."
#
# Why this exists: a track once reported "npm run typecheck exits zero" for a prompt
# whose test file imported two symbols its own mock did not export. The suite could not
# compile, 29 of 29 tests silently skipped, and the checklist came back green. A human
# reading the report could not see it. This script can.
#
# It is deliberately dumb. It runs the commands and reports what happened. It does not
# interpret, does not retry, and has no opinion about whether a failure is acceptable.

set -uo pipefail

LETTER="${1:-}"
BASE="${BOI_BASE:-main}"
if [ -z "$LETTER" ]; then echo "usage: gate.sh <a|b|c|d|e>" >&2; exit 2; fi

cd "$(git rev-parse --show-toplevel)"

case "$LETTER" in
  a) TEST="swift test --package-path mac"
     LINT="swift build --package-path mac -Xswiftc -warnings-as-errors"
     TYPE="" ;;
  b) TEST="python -m pytest"
     LINT="ruff check intelligence && ruff format --check intelligence"
     TYPE="" ;;
  c) TEST="npx vitest run --passWithNoTests cloud/channel cloud/mock-linq"
     LINT="npx eslint ."
     TYPE="npx tsc --noEmit -p tsconfig.json" ;;
  d) TEST="npx vitest run --passWithNoTests cloud/api cloud/brief cloud/card cloud/db"
     LINT="npx eslint ."
     TYPE="npx tsc --noEmit -p tsconfig.json" ;;
  # Track E is the join, so its gate is every other track's gate at once. A change
  # that wires two tracks together can break either of them, and the whole reason this
  # track exists is that nobody has ever run all four suites against one commit.
  e) TEST="npx vitest run --passWithNoTests cloud && python -m pytest && swift test --package-path mac"
     LINT="npx eslint . && ruff check intelligence && ruff format --check intelligence"
     TYPE="npx tsc --noEmit -p tsconfig.json" ;;
  *) echo "unknown track: $LETTER" >&2; exit 2 ;;
esac

# The vitest portion only, for the skipped-suite check below. Running the compound
# TEST there would re-run pytest and swift for a grep, which is slow enough that
# somebody would eventually delete the check.
VITEST_ONLY=""
case "$LETTER" in
  c) VITEST_ONLY="npx vitest run --passWithNoTests cloud/channel cloud/mock-linq" ;;
  d) VITEST_ONLY="npx vitest run --passWithNoTests cloud/api cloud/brief cloud/card cloud/db" ;;
  e) VITEST_ONLY="npx vitest run --passWithNoTests cloud" ;;
esac

FAILED=0
run () {  # run <label> <command>
  label="$1"; cmd="$2"
  [ -z "$cmd" ] && return 0
  printf '\n──────── %s\n$ %s\n' "$label" "$cmd"
  eval "$cmd" 2>&1 | tail -40
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    printf '✗ %s FAILED (exit %s)\n' "$label" "$rc"
    FAILED=1
  else
    printf '✓ %s\n' "$label"
  fi
}

# TYPECHECK FIRST, deliberately. A suite that cannot compile reports zero failures,
# which reads identically to a suite that passed.
run "typecheck" "$TYPE"
run "tests"     "$TEST"
run "lint"      "$LINT"
run "fixtures"  "python3 scripts/validate_fixtures.py"
run "ownership" "bash scripts/check-ownership.sh $LETTER"

# A test file that exists but ran zero tests is the failure mode this whole script is
# named after. Vitest calls it "skipped"; it exits zero either way.
if [ -n "$VITEST_ONLY" ]; then
  printf '\n──────── no-silently-skipped-tests\n'
  skipped=$(eval "$VITEST_ONLY" 2>&1 | grep -Eo '[0-9]+ skipped' | head -1 || true)
  if [ -n "$skipped" ]; then
    printf '✗ vitest reports "%s" — a skipped suite is not a passing suite\n' "$skipped"
    FAILED=1
  else
    printf '✓ no skipped suites\n'
  fi
fi

printf '\n════════════════════════════════════\n'
if [ "$FAILED" -ne 0 ]; then
  printf 'GATE RED — track %s\n\n' "$LETTER"
  printf 'Stop here. Do not start the next prompt. Commit what works with the failure\n'
  printf 'named in the message, write it into NOTES.md, and report.\n'
  exit 1
fi
printf 'GATE GREEN — track %s\n' "$LETTER"
printf 'Commits on this branch:\n'
git --no-optional-locks log --oneline "$BASE"..HEAD 2>/dev/null | sed 's/^/  /'
