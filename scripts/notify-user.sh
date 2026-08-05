#!/usr/bin/env bash
# Notify the human operator that this build needs an interactive decision or credential.
# Usage: bash scripts/notify-user.sh "optional short reason"
set -euo pipefail

reason="${1:-Boi needs your input.}"

# The notification is intentionally best-effort: a headless CI runner must never fail a
# build merely because it cannot play a local sound or display a desktop notification.
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${reason//\"/\\\"}\" with title \"Boi build needs you\"" >/dev/null 2>&1 &
fi

if command -v afplay >/dev/null 2>&1 && [ -f /System/Library/Sounds/Glass.aiff ]; then
  afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &
fi

printf 'NOTIFY_USER: %s\n' "$reason"
