#!/bin/bash
# E2E smoke test for the split extension (split.ts + its modules).
#
# Runs a real pi in a detached tmux session (fullscreen mode comes from
# settings.json) with ONLY the split extension loaded (--no-extensions -e),
# then asserts against the rendered pane:
#   1. clean start, no extension errors
#   2. /split composes: Thinking + Tool Usage + File Changes headers, divider
#   3. /split-width recomposes at a new left share
#   4. a real agent turn (write tool) lands in the Tool Usage panel and the
#      File Changes panel (tracker-driven)
#   5. /split-trim-response reports response-only mode
#   6. /split off restores the bare layout
#   7. the tracker's session-set entry persists in the session jsonl
#
# Mouse drag is NOT tested here (tmux mouse passthrough is unreliable);
# divider math is covered by scripts/test-split-config.ts and drag is
# verified manually in a real terminal.
#
# Cost: one tiny LLM call (thinking off, single write tool use).
#
# Run from the repo root: scripts/test-split-extension.sh

set -u
EXT="$HOME/dotfiles/pi/.pi/agent/extensions/split.ts"
SESSION="split-e2e-$$"
DIR=$(mktemp -d "${HOME}/.split-e2e-XXXXXX")   # NOT under /tmp: tracker hard-excludes temp dirs
PASS=0
FAIL=0
CAP=""

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS+1)); say "  ok  $1"; }
bad() { FAIL=$((FAIL+1)); say "FAIL  $1"; }
check_contains() {
	# check_contains <name> <regex>
	if echo "$CAP" | grep -qE "$2"; then ok "$1"; else bad "$1 (pattern not found: $2)"; fi
}
check_not_contains() {
	if ! echo "$CAP" | grep -qE "$2"; then ok "$1"; else bad "$1 (unexpected pattern found: $2)"; fi
}
capture() { CAP=$(tmux capture-pane -t "$SESSION" -p); }

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null
	rm -rf "$DIR" 2>/dev/null
}
trap cleanup EXIT

say "── split extension E2E (session $SESSION, dir $DIR)"

tmux new-session -d -s "$SESSION" -x 170 -y 46
tmux send-keys -t "$SESSION" "cd $DIR && pi --no-extensions --thinking off -e $EXT" Enter
sleep 12
capture

# 1. clean start
check_not_contains "no startup errors" "Extension.*(error|failed|cannot)|TypeError|ReferenceError"
if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive"; else bad "session alive"; fi

# 2. /split composes the split layout
tmux send-keys -t "$SESSION" "/split" Enter
sleep 2
capture
check_contains "thinking panel header" "Thinking"
check_contains "tool usage panel header" "Tool Usage"
check_contains "file changes panel header" "File Changes"
check_contains "compact divider column" "│"

# 3. /split-width recomposes
tmux send-keys -t "$SESSION" "/split-width 45" Enter
sleep 2
capture
check_contains "width notify" "Left column: 45%"

# 5. response-only mode — test while provably IDLE (before the agent turn):
# a command sent while a turn is still streaming gets queued as a follow-up
# prompt to the model instead of executing.
tmux send-keys -t "$SESSION" "/split-trim-response" Enter
sleep 2
capture
check_contains "trim on notify" "response only"
tmux send-keys -t "$SESSION" "/split-trim-response" Enter
sleep 2
capture
check_contains "trim off notify" "full transcript"

# 4. real agent turn: one write tool call, tracked in both right panels
tmux send-keys -t "$SESSION" "Use the write tool to create a file test.txt containing exactly the word hi in the current directory. Nothing else." Enter
sleep 15
# poll until the turn settles (files panel lists the file) or timeout
for _ in $(seq 1 20); do
	capture
	if echo "$CAP" | grep -q "test.txt"; then break; fi
	sleep 3
done
capture
check_contains "file changes lists the written file" "test.txt"
check_contains "tool usage records the write call" "(✓|●) write"

# Let the turn fully settle before the next command (see the trim note above).
sleep 10

# 6. split off = bare layout
tmux send-keys -t "$SESSION" "/split" Enter
sleep 2
capture
check_contains "split off notify" "Split off"
check_not_contains "panels gone after split off" "Thinking idle|No tools called yet|No changes yet"

# 7. tracker persistence: session-set entry in THIS test's session jsonl
# (sessions are stored as sessions/<sanitized-cwd>--/<timestamp>.jsonl)
NEWEST=$(ls -t "$HOME/.pi/agent/sessions/--Users-luis.aceituno-.split-e2e-"*/*.jsonl 2>/dev/null | head -1)
if [ -n "$NEWEST" ] && grep -q "filechanges:session-set" "$NEWEST" 2>/dev/null; then
	ok "tracker session-set entry persisted ($(basename "$NEWEST"))"
else
	bad "tracker session-set entry persisted"
fi

say ""
say "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
