#!/bin/sh
# Open canopy's live agent registry in a side pane, split right from the
# active pane. Bound to prefix+a in config.toml. See ~/projects/personal/canopy
# (repo: luiul/canopy) for what canopy does and why it's a standalone CLI
# rather than a herdr plugin.
set -e

PANE_ID=$(herdr pane split \
  --pane "$HERDR_ACTIVE_PANE_ID" \
  --direction right \
  --ratio 0.4 \
  --cwd "$HERDR_ACTIVE_PANE_CWD" \
  --focus | jq -r '.result.pane.pane_id')

herdr pane run "$PANE_ID" "canopy status --watch"
