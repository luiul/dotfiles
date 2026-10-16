#!/bin/bash
# E2E smoke test for the split extension (split.ts + its modules).
#
# Runs a real pi in a detached tmux session (fullscreen mode comes from
# settings.json) with ONLY the split extension loaded (--no-extensions -e),
# then asserts against the rendered pane:
#   1. clean start, no extension errors
#   2. /split composes: Thinking + Tool Usage + File Changes headers, divider
#   3. /split-width recomposes at a new left share
#   4. a real agent turn (two write calls, one with a long nested path) lands
#      in the Tool Usage and File Changes panels, and the long path WRAPS
#      (hanging indent) instead of truncating
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
check_in_right() {
	if echo "$CAP_R" | grep -qE "$2"; then ok "$1"; else bad "$1 (pattern not found in right column: $2)"; fi
}
check_not_contains() {
	if ! echo "$CAP" | grep -qE "$2"; then ok "$1"; else bad "$1 (unexpected pattern found: $2)"; fi
}
capture() { CAP=$(tmux capture-pane -t "$SESSION" -p); }
# Right-column region only: cut just right of the divider so panel
# assertions cannot match transcript text. The divider column is computed
# live (it moves with /split-width), and +2 skips the divider itself and the
# panels' one leading space column (panel content used to sit one column
# further right, before the body rail was removed from the panels).
capture_right() {
	DIV=$(divider_col)
	CAP_R=$(tmux capture-pane -t "$SESSION" -p | cut -c $(( DIV < 0 ? 80 : DIV + 2 ))-)
}

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

# 2. /split composes the split layout. The toggle only turns the layout ON
#    when it is currently off: the saved ~/.pi/agent/split.json startup
#    defaults may already have composed it at boot (split: true), and a blind
#    toggle would turn it OFF and fail every panel assertion. So only send the
#    toggle when the panels are not already on screen.
capture
if echo "$CAP" | grep -q "Tool Usage"; then
	say "── split already composed at startup (saved or built-in default; no toggle needed)"
else
	tmux send-keys -t "$SESSION" "/split" Enter
	sleep 2
fi
capture
check_contains "thinking panel header" "Thinking"
check_contains "tool usage panel header" "Tool Usage"
check_contains "file changes panel header" "File Changes"
check_contains "compact divider column" "│"

# 3. /split-width recomposes. The "Left column: 45%" notify is invisible
#    while response-only is active (the extension's documented notify blind
#    spot), so assert the divider actually moved instead: its column is the
#    one where nearly every rendered row has │. 45% of 170 cols ≈ column 76.
divider_col() {
	tmux capture-pane -t "$SESSION" -p | python3 -c '
import sys, collections
cnt = collections.Counter()
for line in sys.stdin:
    for col, ch in enumerate(line.rstrip("\n")):
        if ch == "│":
            cnt[col] += 1
print(cnt.most_common(1)[0][0] if cnt else -1)
'
}
DIV0=$(divider_col)
tmux send-keys -t "$SESSION" "/split-width 45" Enter
sleep 2
DIV1=$(divider_col)
if [ "$DIV1" -ge 70 ] && [ "$DIV1" -le 82 ]; then ok "divider moved to 45% (col $DIV0 → $DIV1)"; else bad "divider at 45% (got col $DIV1, was $DIV0)"; fi

# 5. response-only mode — test while provably IDLE (before the agent turn):
# a command sent while a turn is still streaming gets queued as a follow-up
# prompt to the model instead of executing. Toggles are direction-agnostic:
# the saved startup config may start in either state, so assert the status
# hint appears and cycles ("left: response only" <-> "left: full transcript",
# both visible in either view; the notify itself is blind-spotted).
tmux send-keys -t "$SESSION" "/split-trim-response" Enter
sleep 2
capture
HINT1=$(echo "$CAP" | grep -oE "left: (response only|full transcript)" | head -1)
if [ -n "$HINT1" ]; then ok "trim toggle 1 shows hint ($HINT1)"; else bad "trim toggle 1 shows hint"; fi
tmux send-keys -t "$SESSION" "/split-trim-response" Enter
sleep 2
capture
HINT2=$(echo "$CAP" | grep -oE "left: (response only|full transcript)" | head -1)
if [ -n "$HINT2" ] && [ "$HINT2" != "$HINT1" ]; then ok "trim toggle 2 cycles hint ($HINT2)"; else bad "trim toggle 2 cycles hint (got '$HINT2', had '$HINT1')"; fi

# 4. real agent turn: two write calls (one long nested path), tracked in the
# right panels; the long path must WRAP in File Changes, not truncate.
tmux send-keys -t "$SESSION" "Use the write tool twice: create test.txt containing exactly the word hi, and create deeply/nested/directory/structure/with/a/very-long-descriptive-file-name.md containing exactly the word ok. Both in the current directory. Nothing else." Enter
sleep 15
# poll until the LAST artifact (the long-path write) appears, then settle.
for _ in $(seq 1 20); do
	capture
	if echo "$CAP" | grep -q "very-long"; then break; fi
	sleep 3
done
capture
check_contains "file changes lists the written file" "test.txt"
check_contains "tool usage records the write call" "(✓|●) write"
capture_right
check_in_right "file changes wraps the long path" "deeply/nested"
check_in_right "file changes lists both files" "\(\+1/-0\)"
# Both write calls in the tool panel (compact: adjacent lines, no blanks).
WRITES=$(echo "$CAP_R" | grep -cE "(✓|●) write")
if [ "$WRITES" -ge 2 ]; then ok "tool usage lists both writes"; else bad "tool usage lists both writes (found $WRITES of 2)"; fi

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
