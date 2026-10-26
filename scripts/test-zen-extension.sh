#!/bin/bash
# E2E test for compact tool calls (one spacer plus one content row, zen.ts).
#
# Runs real pi instances in a detached tmux session on a SEEDED session
# (thinking, successful and failed bash calls, a long multiline command,
# a read range, an MCP proxy call, and text; crafted jsonl, no LLM needed)
# with only the zen extension loaded (--no-extensions
# -e), then asserts against the rendered pane:
#   1. clean start, no extension errors
#   2. compact by default: the successful call is exactly one line, its
#      output hidden, a ✓ suffix on the line; the FAILED call is also one
#      line with the error text on it (✗); thinking collapsed by the
#      native hideThinkingBlock setting
#   3. ctrl+o (native global expand) shows the hidden output, and again
#      collapses back to one line with the suffix restored
#   4. /zen off restores the full native transcript (output preview visible)
#   5. /zen on compacts again
#   6. /reload keeps compact mode
#   7. parity: a --no-zen capture and a bare-pi capture of the same seed
#      match line for line (the extension with compact mode off changes
#      nothing about the transcript)
#   8. live turn (optional, costs one LLM call): a real bash call renders
#      as one line with a suffix and the answer still appears.
#      Set ZEN_E2E_LIVE=1 to run it.
#
# The zen toggle persists to the real ~/.pi/agent/zen.json by design, so the
# script backs it up and restores it in the EXIT trap.
#
# Run from the repo root: scripts/test-zen-extension.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/pi/.pi/agent/extensions/zen.ts"
SESSION="ag-zen-e2e-$$"
DIR=$(mktemp -d "${HOME}/.zen-e2e-XXXXXX")   # NOT under /tmp: the tracker
                                               # hard-excludes temp dirs
SESSDIR="$HOME/.pi/agent/sessions/--Users-luis-aceituno-.zen-e2e-$$--"
mkdir -p "$SESSDIR"
SEED="$SESSDIR/2026-10-26T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl"
CONFIG="$HOME/.pi/agent/zen.json"
BACKUP="$DIR/zen.json.bak"
PASS=0
FAIL=0
HAD_CONFIG=0

say() { echo "── $*"; }
ok() { PASS=$((PASS + 1)); echo "  ok  $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $*"; }

CAP=""
capture() { CAP=$(tmux capture-pane -t "$SESSION" -p); }
check_contains() { capture; if echo "$CAP" | grep -qF -- "$2"; then ok "$1"; else bad "$1"; fi; }
check_not_contains() { capture; if echo "$CAP" | grep -qF -- "$2"; then bad "$1"; else ok "$1"; fi; }
check_not_matches() { capture; if printf '%s\n' "$CAP" | grep -qiE -- "$2"; then bad "$1"; else ok "$1"; fi; }
check_compact_geometry() {
	local width="$1"
	tmux capture-pane -t "$SESSION" -p > "$DIR/geometry.txt"
	# Inspect actual pane rows, not counts inferred from substring matches.
	if uv run --no-project python - "$DIR/geometry.txt" "$width" <<'PYEOF'
import re, sys, unicodedata
lines = open(sys.argv[1]).read().splitlines()
width = int(sys.argv[2])
patterns = [r'^\$ ls -la', r'^\$ .*✗ cat:', r'^\$ printf ZENLONG-CMD', r'^read ', r'^mcp browser_snapshot']
positions = []
for pattern in patterns:
    found = [i for i, line in enumerate(lines) if re.search(pattern, line.strip())]
    if len(found) != 1:
        raise SystemExit(f'{pattern}: expected one row, got {len(found)}')
    row = found[0]
    if row == 0 or lines[row - 1].strip():
        raise SystemExit(f'{pattern}: missing empty spacer row')
    columns = sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in lines[row])
    if columns > width:
        raise SystemExit(f'{pattern}: width {columns} exceeds {width}')
    positions.append(row)
if any(b - a != 2 for a, b in zip(positions, positions[1:])):
    raise SystemExit(f'expected two physical rows per adjacent call, got positions {positions}')
PYEOF
	then ok "compact fixtures have two rows and fit width $width"
	else bad "compact fixtures have two rows and fit width $width"
	fi
}
send() { tmux send-keys -t "$SESSION" "$1" Enter; }

cleanup() {
	if [ -f "$DIR/watchdogs" ]; then
		while IFS= read -r pid; do
			pkill -P "$pid" 2>/dev/null || true
			kill "$pid" 2>/dev/null || true
		done < "$DIR/watchdogs"
	fi
	tmux kill-session -t "$SESSION" 2>/dev/null
	if [ "$HAD_CONFIG" = 1 ]; then
		mv "$BACKUP" "$CONFIG" 2>/dev/null
	else
		rm -f "$CONFIG"
	fi
	rm -rf "$DIR" "$SESSDIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Bound every detached test session even if the parent shell is killed.
WATCHDOG="(sleep 240; tmux kill-session -t '$SESSION' 2>/dev/null) >/dev/null 2>&1 & echo \$! >> '$DIR/watchdogs';"

# Back up the real zen config (the toggle persists by design).
if [ -f "$CONFIG" ]; then HAD_CONFIG=1; cp "$CONFIG" "$BACKUP"; fi

# ─── seed ─────────────────────────────────────────────────────────────────────
uv run --no-project python - "$SEED" "$DIR" <<'PYEOF'
import json, sys
p, cwd = sys.argv[1], sys.argv[2]
ts = lambda i: f"2026-10-26T00:00:{i:02d}.000Z"
usage = lambda n: {"input": 100, "output": n, "cacheRead": 0, "cacheWrite": 0,
	"totalTokens": 100 + n, "cost": {"input": 0.001, "output": 0.001,
	"cacheRead": 0, "cacheWrite": 0, "total": 0.002}}
def msg(mid, pid, n, content, stop):
	return {"type": "message", "id": mid, "parentId": pid, "timestamp": ts(n),
		"message": {"role": "assistant", "content": content, "model": "test-model",
		"stopReason": stop, "usage": usage(10)}}
lines = [
 {"type": "session", "version": 3, "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "timestamp": ts(0), "cwd": cwd},
 {"type": "model_change", "id": "m1", "parentId": None, "timestamp": ts(0), "provider": "test", "modelId": "test-model"},
 {"type": "message", "id": "u1", "parentId": "m1", "timestamp": ts(1), "message": {"role": "user", "content": [{"type": "text", "text": "list the files and say hello"}]}},
 msg("a1", "u1", 2, [{"type": "thinking", "thinking": "The user wants a file listing and a greeting. I will run ls via the bash tool, keep it short, and say hello."}, {"type": "text", "text": "I will take a look at the files first."}], "stop"),
 msg("a2", "a1", 3, [{"type": "toolCall", "id": "tc1", "name": "bash", "arguments": {"command": "ls -la"}}], "toolUse"),
 {"type": "message", "id": "r1", "parentId": "a2", "timestamp": ts(4), "message": {"role": "toolResult", "toolCallId": "tc1", "content": [{"type": "text", "text": "total 8\n-rw-r--r--  1 luis  staff   64 Oct 26 00:00 ZENOUT-MARKER.txt"}], "isError": False}},
 msg("a3", "r1", 5, [{"type": "toolCall", "id": "tc2", "name": "bash", "arguments": {"command": "cat missing.txt"}}], "toolUse"),
 {"type": "message", "id": "r2", "parentId": "a3", "timestamp": ts(6), "message": {"role": "toolResult", "toolCallId": "tc2", "content": [{"type": "text", "text": "cat: missing.txt: No such file or directory"}], "isError": True}},
 msg("a-long", "r2", 7, [{"type": "toolCall", "id": "tc-long", "name": "bash", "arguments": {"command": "printf ZENLONG-CMD 日本語 " + "long-segment " * 16 + "\necho ZENMULTILINE-TAIL"}}], "toolUse"),
 {"type": "message", "id": "r-long", "parentId": "a-long", "timestamp": ts(8), "message": {"role": "toolResult", "toolCallId": "tc-long", "content": [{"type": "text", "text": "ZENLONG-OUTPUT\nsecond output line"}], "details": {"truncation": {"truncated": True, "truncatedBy": "lines", "outputLines": 2, "totalLines": 200, "maxLines": 2}, "fullOutputPath": "/tmp/zen-full-output.txt"}, "isError": False}},
 msg("a-read", "r-long", 9, [{"type": "toolCall", "id": "tc-read", "name": "read", "arguments": {"path": cwd + "/" + "nested/" * 12 + "ZENRANGE.txt", "offset": 120, "limit": 61}}], "toolUse"),
 {"type": "message", "id": "r-read", "parentId": "a-read", "timestamp": ts(10), "message": {"role": "toolResult", "toolCallId": "tc-read", "content": [{"type": "text", "text": "ZENREAD-OUTPUT\nsecond read line"}], "isError": False}},
 msg("a-mcp", "r-read", 11, [{"type": "toolCall", "id": "tc-mcp", "name": "mcp", "arguments": {"tool": "browser_snapshot", "args": {"filename": "/tmp/ZENMCP-snapshot.md"}}}], "toolUse"),
 {"type": "message", "id": "r-mcp", "parentId": "a-mcp", "timestamp": ts(12), "message": {"role": "toolResult", "toolCallId": "tc-mcp", "content": [{"type": "text", "text": "ZENMCP-OUTPUT\nsecond snapshot line"}], "isError": False}},
 msg("a4", "r-mcp", 13, [{"type": "thinking", "thinking": "The file was missing, an error. I should report the failure clearly and offer the successful listing."}, {"type": "text", "text": "Hello! The listing worked and shows a marker file. The second command failed because missing.txt does not exist."}], "stop"),
]
open(p, "w").write("\n".join(json.dumps(l) for l in lines) + "\n")
PYEOF

start_pi() {
	# start_pi <extra args...>
	tmux kill-session -t "$SESSION" 2>/dev/null
	tmux new-session -d -s "$SESSION" -x 120 -y 70
	tmux send-keys -t "$SESSION" "cd $DIR && $WATCHDOG PI_TUI_WRITE_LOG=$DIR/tui-write.log pi --offline --no-extensions $* --session $SEED" Enter
	sleep 10
}

strip_volatile() {
	# Drop lines that legitimately differ between runs: zen's own notify
	# lines, the model-restore warning (order/timing), and the tmux hint.
	grep -vE ' zen: |Could not restore model|tmux extended-keys|^\s*$'
}

say "zen v2 extension E2E (session $SESSION, dir $DIR)"

# ─── 1 + 2: clean start, compact by default ────────────────────────────────
start_pi "-e $EXT --zen"
if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive"; else bad "session alive"; fi
check_not_matches "no startup errors" 'Extension.*(error|failed|cannot)|TypeError|ReferenceError'
check_contains "successful call visible as one line (\$ ls -la)" '$ ls -la'
check_not_contains "successful call output hidden while compact" "ZENOUT-MARKER"
check_contains "success suffix on the line (✓)" "✓"
check_contains "thinking collapsed to native label" "Thinking..."
check_not_contains "thinking content hidden" "The user wants a file listing"
check_contains "failed call visible as one line (\$ cat missing.txt)" '$ cat missing.txt'
check_contains "error text on the failed line" "✗ cat: missing.txt: No such file or directory"
check_contains "conversation text intact" "Hello! The listing worked"
check_contains "read range and tail-fitted filename visible" "ZENRANGE.txt:120–180"
check_contains "MCP proxy operation visible" "mcp browser_snapshot"
check_contains "structured truncation warning visible" "truncated"
check_not_contains "multiline command tail hidden while compact" "ZENMULTILINE-TAIL"
check_not_contains "MCP output hidden while compact" "ZENMCP-OUTPUT"
check_compact_geometry 120
for width in 80 40; do
	tmux resize-window -t "$SESSION" -x "$width" -y 100
	sleep 2
	check_compact_geometry "$width"
	check_contains "filename and range retained at width $width" "ZENRANGE.txt:120–180"
done
tmux resize-window -t "$SESSION" -x 120 -y 70
sleep 2

# ─── 3: ctrl+o expands natively, and collapses back ─────────────────────────
tmux send-keys -t "$SESSION" C-o
sleep 2
check_contains "ctrl+o expands the success block" "ZENOUT-MARKER"
check_contains "ctrl+o retains multiline command tail" "ZENMULTILINE-TAIL"
check_contains "ctrl+o expands MCP output" "ZENMCP-OUTPUT"
check_contains "ctrl+o retains truncation warning" "Truncated: showing 2 of 200 lines"
tmux send-keys -t "$SESSION" C-o
sleep 2
check_not_contains "ctrl+o again collapses the block" "ZENOUT-MARKER"
check_contains "suffix restored after collapse" "✓"

# ─── 4: /zen off restores the native transcript ───────────────────────────
send "/zen"
sleep 2
check_contains "tool output restored (marker preview)" "ZENOUT-MARKER"

# ─── 5: /zen on compacts again ─────────────────────────────────────────────
send "/zen"
sleep 2
check_not_contains "compact again: output hidden" "ZENOUT-MARKER"
check_contains "compact again: suffix visible" "✓"

# ─── 6: /reload keeps compact mode ─────────────────────────────────────────
send "/reload"
sleep 8
check_contains "still compact after /reload (call visible)" '$ ls -la'
check_not_contains "still compact after /reload (output hidden)" "ZENOUT-MARKER"
check_contains "still compact after /reload (suffix visible)" "✓"

# ─── 7: parity — --no-zen capture equals bare-pi capture ───────────────────
start_pi "-e $EXT --no-zen"
sleep 2
tmux capture-pane -t "$SESSION" -p | strip_volatile > "$DIR/cap-zen-off.txt"
tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x 120 -y 70
tmux send-keys -t "$SESSION" "cd $DIR && $WATCHDOG pi --no-extensions --session $SEED" Enter
sleep 10
tmux capture-pane -t "$SESSION" -p | strip_volatile > "$DIR/cap-bare.txt"
if diff -u "$DIR/cap-bare.txt" "$DIR/cap-zen-off.txt" > "$DIR/parity.diff" 2>&1; then
	ok "zen off = bare pi, line for line"
else
	bad "zen off = bare pi (see $DIR/parity.diff)"
	uv run --no-project python - "$DIR/parity.diff" <<'PYEOF'
import sys
print(''.join(open(sys.argv[1]).readlines()[:30]), end='')
PYEOF
fi

# ─── 8: one live agent turn (optional, one small LLM call) ─────────────────
if [ "${ZEN_E2E_LIVE:-0}" = 1 ]; then
	start_pi "-e $EXT"
	send "use the bash tool to run exactly: echo zen-live-e2e; sleep 2; echo zen-live-finished. Then answer with one short sentence."
	sleep 45
	check_contains "live call visible as one line" '$ echo zen-live-e2e'
	check_contains "live call got a status suffix" "✓"
	check_contains "live answer appears" "zen-live-e2e"
	for repeat in 1 2 3; do
		before=$(wc -c < "$DIR/tui-write.log")
		sleep 2
		after=$(wc -c < "$DIR/tui-write.log")
		if [ "$before" = "$after" ]; then ok "live idle check $repeat: zero terminal writes"; else bad "live idle check $repeat: terminal still redraws"; fi
	done
	if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive after the live turn"; else bad "session alive after the live turn"; fi
else
	say "live turn skipped (set ZEN_E2E_LIVE=1 to run)"
fi

echo ""
echo "zen v2 extension E2E: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
