#!/usr/bin/env bash
# Behavior-level smoke test for pi's notifications extension.
#
# Runs an interactive pi in a detached tmux session with a 2s long-run
# threshold, asks it to sleep 5s, and asserts a real notification lands in
# `claude-notifier logs`. The long-run watcher bypasses focus suppression, so
# the test works regardless of which app is frontmost. Extensions autoload
# from ~/.pi/agent/extensions, so this tests the real stowed setup.
#
# Requires: tmux, claude-notifier, pi with working model auth (Bedrock SSO).
# Exits 0 on PASS, 1 on FAIL.

set -euo pipefail

SESSION="pi-notify-smoke"
WORKDIR="$(mktemp -d)"

count_delivered() {
	claude-notifier logs 2>/dev/null | grep -c "Notification delivered" || true
}

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

tmux kill-session -t "$SESSION" 2>/dev/null || true
before="$(count_delivered)"

tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR"
tmux send-keys -t "$SESSION" "PI_LONG_RUN_SECONDS=2 pi --no-session" Enter

# Wait for the TUI to come up, then submit a prompt that keeps the agent busy
# longer than the threshold.
sleep 8
tmux send-keys -t "$SESSION" "Run sleep 5 via bash, then reply with exactly OK." Enter

# Give the run time to finish and the watcher to fire.
sleep 20

after="$(count_delivered)"
if [ "$after" -gt "$before" ]; then
	echo "PASS: notification delivered (delivered count $before -> $after)"
else
	echo "FAIL: no notification delivered. Last pane state:"
	tmux capture-pane -t "$SESSION" -p | tail -20
	exit 1
fi
