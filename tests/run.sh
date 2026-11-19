#!/bin/bash
# Runs the unit tests, then an end-to-end tmux test with a fake `claude` (never the real one),
# then the status band's parsing tests (Node 22.18+ runs TypeScript directly).
set -e
T="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-$(command -v python3)}"
"$PY" "$T/test_claude_sub.py" -v
if command -v node >/dev/null; then
  node --test "$T/test_status.ts"
else
  echo "node not found: skipped the status band tests" >&2
  [ -z "$CI" ] || exit 1
fi
