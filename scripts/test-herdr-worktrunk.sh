#!/usr/bin/env bash
# Isolated named Herdr server, real wt/cop checkouts, no live user workspace changes.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
session="ag-herdr-wt-$$"
tmux_name="$session"
cleanup() {
  herdr session stop "$session" --json >/dev/null 2>&1 || true
  tmux kill-session -t "$tmux_name" 2>/dev/null || true
  herdr session delete "$session" --json >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
printf -v command 'HERDR_CONFIG_PATH=%q herdr --session %q server' "$root/herdr/.config/herdr/config.toml" "$session"
tmux new-session -d -s "$tmux_name" -x 140 -y 38 "$command"
for ((attempt=0; attempt<50; attempt++)); do
  if herdr --session "$session" workspace list >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
HERDR_WT_TEST_SESSION="$session" uv run "$root/scripts/test-herdr-worktrunk.py"
