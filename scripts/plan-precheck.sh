#!/usr/bin/env bash
# Automation precheck: exit 0 only when there is an open subtask and no session lock younger than 100 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
LOCK="$HOME/.cache/foreman-plan.lock"
if [ -f "$LOCK" ] && [ -n "$(find "$LOCK" -mmin -100 2>/dev/null)" ]; then
  echo "skip: another plan session is running (lock $(cat "$LOCK"))"; exit 3
fi
NEXT="$(bash scripts/plan-next.sh)"
if [ -z "$NEXT" ]; then echo "skip: no open subtask in PLAN.md"; exit 4; fi
echo "next: $NEXT"
