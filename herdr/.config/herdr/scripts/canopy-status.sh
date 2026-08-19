#!/bin/sh
# Open canopy (github.com/luiul/canopy) in a side pane: an interactive
# dashboard of every pi/claude/codex/... session on this machine, herdr
# panes, VS Code integrated terminals, and bare Ghostty tabs alike, with
# jump-to-window on Enter or click. Bound to prefix+a in config.toml.
set -e

PANE_ID=$(herdr pane split \
  --pane "$HERDR_ACTIVE_PANE_ID" \
  --direction right \
  --ratio 0.4 \
  --cwd "$HERDR_ACTIVE_PANE_CWD" \
  --focus | jq -r '.result.pane.pane_id')

herdr pane run "$PANE_ID" "canopy"
