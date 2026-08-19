#!/bin/bash
# Read-only viewer pane for the agent-radar registry (dotfiles#11 phase 2).
# Opened via `herdr plugin action invoke luiul.agent-radar.open-radar` or
# the pane action bound in herdr-plugin.toml. Redraws every 2 seconds until
# the pane is closed.
set -uo pipefail

STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-.}"
REGISTRY="$STATE_DIR/registry.json"

trap 'exit 0' INT TERM

while true; do
  clear
  echo "Agent Radar — read-only (dotfiles#11, phases 0-2)"
  echo "watcher state: $STATE_DIR"
  echo

  if [ -f "$REGISTRY" ]; then
    GENERATED_AT="$(jq -r '.generated_at // "unknown"' "$REGISTRY" 2>/dev/null)"
    DRY_RUN="$(jq -r '.dry_run // false' "$REGISTRY" 2>/dev/null)"
    echo "last poll: $GENERATED_AT   dry_run=$DRY_RUN"
    echo

    COUNT="$(jq '.entries | length' "$REGISTRY" 2>/dev/null || echo 0)"
    if [ "$COUNT" = "0" ]; then
      echo "No agent-kind processes detected."
    else
      {
        echo -e "KIND\tPID\tTTY\tSTATUS\tWORKSPACE\tCWD"
        jq -r '
          .entries[]
          | [
              .kind,
              (.pid|tostring),
              .tty,
              (if .tracked then "tracked" elif .stale then "stale" else "external" end),
              ((.workspace_ids // []) | if length == 0 then "-" else join(",") end),
              (.cwd // "?")
            ]
          | @tsv
        ' "$REGISTRY" 2>/dev/null
      } | column -t -s $'\t'
    fi
  else
    echo "No registry yet. Waiting for the watcher to write $REGISTRY ..."
    echo "If this persists, check $STATE_DIR/watch.log."
  fi

  echo
  echo "tracked  = already visible in herdr's own Agents section"
  echo "external = agent running outside any herdr pane (the #11 gap)"
  echo "stale    = missed the last poll, about to drop if it stays missing"
  echo
  echo "(ctrl-c to close)"
  sleep 2
done
