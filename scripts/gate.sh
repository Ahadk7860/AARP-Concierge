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
if [ -z "$LETTER" ]; then echo "usage: gate.sh <a|b|c|d|e|f>" >&2; exit 2; fi

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
  f) TEST="swift test --package-path mac"
     LINT="swift build --package-path mac -Xswiftc -warnings-as-errors"
     TYPE="" ;;
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

# A gate is a claim about a commit. Running it over a dirty tree measures something
# that does not exist in history, and editing the tree WHILE it runs measures two
# different trees in one report. Track E hit both, twice, having written the rule down
# in between — which is the argument for enforcing it here rather than in prose.
if [ -n "$(git --no-optional-locks status --porcelain 2>/dev/null)" ]; then
  echo "GATE REFUSED — the working tree is dirty."
  git --no-optional-locks status --porcelain | sed 's/^/  /'
  echo
  echo "Commit (or stash) first. A green gate over uncommitted work is not evidence"
  echo "about any commit, and it is the exact shape of report this project keeps"
  echo "catching. Set BOI_GATE_ALLOW_DIRTY=1 only if you know why you are doing it."
  [ "${BOI_GATE_ALLOW_DIRTY:-0}" = "1" ] || exit 2
  echo "BOI_GATE_ALLOW_DIRTY=1 — continuing, and this report is not evidence."
fi

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

# A suite that SHRANK reports as a pass in every mechanism above.
#
# The checks so far catch a suite that cannot compile, and one that ran zero tests. None
# of them notices a suite that is simply SMALLER than it was — a deleted test file, a
# reverted edit, a `git checkout` over uncommitted work — because the tests that remain
# all pass and the exit code is zero. It was found by hand: 257 came back where 258 was
# expected, and only the arithmetic gave it away. A green suite with the wrong number of
# tests is not green, and nobody should have to remember last week's number to see it.
#
# Reported, deliberately not enforced. Removing a superseded test is legitimate — this
# track did it when prompt 02 overturned two of prompt 01's assertions — so an automatic
# red here would be a check people learn to route around. Printing the delta makes a
# shrink something a reader has to look at and account for.
COUNT_CMD=""
case "$LETTER" in
  a|f) COUNT_CMD="swift test --package-path mac --list-tests" ;;
esac
if [ -n "$COUNT_CMD" ]; then
  printf '\n──────── test census\n'
  discovered=$(eval "$COUNT_CMD" 2>/dev/null | grep -cE '^[A-Za-z_][A-Za-z0-9_]*\.' || true)
  printf 'tests discovered by the runner: %s\n' "${discovered:-unknown}"

  # Declared test functions, from git rather than the working tree, so this compares two
  # commits rather than a commit against whatever is on disk.
  declared_at () {
    git grep -hcE '^[[:space:]]*func test[A-Za-z0-9_]*\(' "$1" -- 'mac/Tests' 2>/dev/null \
      | awk '{ total += $1 } END { print total + 0 }'
  }
  now=$(declared_at HEAD)
  printf 'test functions declared at HEAD: %s\n' "$now"
  if git rev-parse --verify -q HEAD~1 >/dev/null; then
    prev=$(declared_at HEAD~1)
    delta=$((now - prev))
    if [ "$delta" -lt 0 ]; then
      printf '!! the suite SHRANK by %s since HEAD~1 (%s -> %s)\n' "${delta#-}" "$prev" "$now"
      printf '   Not a failure by itself — superseded tests get deleted. But say why in\n'
      printf '   the report, because a vanished test passes every other check here.\n'
    else
      printf 'change since HEAD~1: %+d (was %s)\n' "$delta" "$prev"
    fi
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
