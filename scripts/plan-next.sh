#!/usr/bin/env bash
# Prints the id of the next open subtask in PLAN.md (first "- [ ] P<n>.<m>" line), or nothing.
# Lines marked [x] (done), [!] (blocked) or prefixed "AV" (Aaron verifies) are never picked.
set -euo pipefail
cd "$(dirname "$0")/.."
grep -m1 -oE '^- \[ \] P[0-9]+\.[0-9]+' PLAN.md | sed 's/^- \[ \] //' || true
