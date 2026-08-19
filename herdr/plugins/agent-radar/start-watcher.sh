#!/bin/bash
# Startup hook for the agent-radar plugin.
#
# herdr startup hooks are one-shot and NOT supervised daemons: herdr runs
# this once per session-restore or live-handoff and moves on. To get a
# persistent watcher we background the real loop (watch.mjs) ourselves,
# guarded by a pidfile so repeated startup firings never stack up more
# than one running watcher.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$PLUGIN_ROOT/.state}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$PLUGIN_ROOT/.config}"
mkdir -p "$STATE_DIR"

PIDFILE="$STATE_DIR/watcher.pid"
LOG="$STATE_DIR/watch.log"

if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date -u +%FT%TZ)] watcher already running (pid $OLD_PID), skipping" >>"$LOG"
    exit 0
  fi
fi

# Optional user overrides, e.g. AGENT_RADAR_POLL_MS=10000, dropped by the
# user under HERDR_PLUGIN_CONFIG_DIR/config.env. Never created by us.
if [ -f "$CONFIG_DIR/config.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$CONFIG_DIR/config.env"
  set +a
fi

chmod +x "$PLUGIN_ROOT/watch.mjs" 2>/dev/null || true

nohup "$PLUGIN_ROOT/watch.mjs" >>"$LOG" 2>&1 &
WATCHER_PID=$!
echo "$WATCHER_PID" > "$PIDFILE"
disown "$WATCHER_PID" 2>/dev/null || true
echo "[$(date -u +%FT%TZ)] watcher started (pid $WATCHER_PID)" >>"$LOG"
exit 0
