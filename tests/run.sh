#!/bin/bash
# Runs the unit tests, then an end-to-end tmux test with a fake `claude` (never the real one).
T="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-$(command -v python3)}"
"$PY" "$T/test_claude_sub.py" -v
