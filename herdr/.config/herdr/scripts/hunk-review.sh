#!/bin/sh
# Open hunk in a side pane, split right from the active pane.
# Bound to cmd+i in config.toml.
set -e

PANE_ID=$(herdr pane split \
  --pane "$HERDR_ACTIVE_PANE_ID" \
  --direction right \
  --ratio 0.4 \
  --cwd "$HERDR_ACTIVE_PANE_CWD" \
  --focus | jq -r '.result.pane.pane_id')

herdr pane run "$PANE_ID" "hunk diff"
