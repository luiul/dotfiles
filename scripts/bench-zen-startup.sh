#!/bin/bash
# Same-backend private Rex measurements, with at least seven rotated repeats.
# Usage: scripts/bench-zen-startup.sh startup|seeded bare zen1 [zen2 ...]
# Includes Rex creation/login startup overhead. No old timing comparisons.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/bench-zen-startup-live.mjs" "$@"
