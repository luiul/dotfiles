#!/bin/bash
# Seeded private Rex TUI checks. No live HOME writes or default model calls.
# The Node companion documents the explicit optional paid-turn gates.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/test-zen-extension-live.mjs" "$@"
