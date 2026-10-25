#!/bin/bash
# E2E smoke test for the zen extension (transcript filter, zen.ts).
#
# Runs real pi instances in a detached tmux session on a SEEDED session
# (thinking + one passing tool call + one failing tool call + text answers;
# crafted jsonl, no LLM needed) with only the zen extension loaded
# (--no-extensions -e), then asserts against the rendered pane:
#   1. clean start, no extension errors
#   2. --zen: filtered by default — no tool-call ink, thinking collapsed
#      to the native "Thinking..." label, the FAILED call stays visible
#      with native styling, conversation text intact
#   3. /zen off: full native transcript restored
#   4. /zen on: filtered again
#   5. parity: a --no-zen capture and a bare-pi capture of the same seed
#      match line for line (the extension with the filter off changes
#      nothing about the transcript)
#   6. /reload: still filtered (session_start re-applies from the config)
#   7. one LIVE agent turn (a single echo call): the tool block never
#      appears, the answer does
#
# The zen toggle persists to the real ~/.pi/agent/zen.json by design,
# so the script backs it up and restores it in the EXIT trap.
#
# Cost: one tiny LLM call. Run from the repo root:
#   scripts/test-zen-extension.sh

set -u
EXT="$(cd "$(dirname "$0")/.." && pwd)/pi/.pi/agent/extensions/zen.ts"
SESSION="zen-e2e-$$"
DIR=$(mktemp -d "${HOME}/.zen-e2e-XXXXXX")   # NOT under /tmp: the tracker
                                               # hard-excludes temp dirs
SESSDIR="$HOME/.pi/agent/sessions/--Users-luis.aceituno-.zen-e2e-$$--"
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
send() { tmux send-keys -t "$SESSION" "$1" Enter; }

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null
	rm -rf "$DIR" "$SESSDIR"
	if [ "$HAD_CONFIG" = 1 ]; then
		mv "$BACKUP" "$CONFIG" 2>/dev/null
	else
		rm -f "$CONFIG"
	fi
}
trap cleanup EXIT

# Back up the real zen config (the toggle persists by design).
if [ -f "$CONFIG" ]; then HAD_CONFIG=1; cp "$CONFIG" "$BACKUP"; fi

# ─── seed ─────────────────────────────────────────────────────────────────────
python3 - "$SEED" "$DIR" <<'PYEOF'
import json, sys
p, cwd = sys.argv[1], sys.argv[2]
ts = lambda i: f"2026-10-26T00:00:{i:02d}.000Z"
usage = lambda n: {"input": 100, "output": n, "cacheRead": 0, "cacheWrite": 0,
	"totalTokens": 100 + n, "cost": {"input": 0.001, "output": 0.001,
	"cacheRead": 0, "cacheWrite": 0, "total": 0.002}}
lines = [
 {"type": "session", "version": 3, "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "timestamp": ts(0), "cwd": cwd},
 {"type": "model_change", "id": "m1", "parentId": None, "timestamp": ts(0), "provider": "test", "modelId": "test-model"},
 {"type": "message", "id": "u1", "parentId": "m1", "timestamp": ts(1), "message": {"role": "user", "content": [{"type": "text", "text": "list the files and say hello"}]}},
 {"type": "message", "id": "a1", "parentId": "u1", "timestamp": ts(2), "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "The user wants a file listing and a greeting. I will run ls via the bash tool, keep it short, and say hello."}, {"type": "text", "text": "I will take a look at the files first."}], "model": "test-model", "stopReason": "stop", "usage": usage(20)}},
 {"type": "message", "id": "a2", "parentId": "a1", "timestamp": ts(3), "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "tc1", "name": "bash", "arguments": {"command": "ls -la"}}], "model": "test-model", "stopReason": "toolUse", "usage": usage(10)}},
 {"type": "message", "id": "r1", "parentId": "a2", "timestamp": ts(4), "message": {"role": "toolResult", "toolCallId": "tc1", "content": [{"type": "text", "text": "total 8\n-rw-r--r--  1 luis  staff   64 Oct 26 00:00 README.md"}], "isError": False}},
 {"type": "message", "id": "a3", "parentId": "r1", "timestamp": ts(5), "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "tc2", "name": "bash", "arguments": {"command": "cat missing.txt"}}], "model": "test-model", "stopReason": "toolUse", "usage": usage(10)}},
 {"type": "message", "id": "r2", "parentId": "a3", "timestamp": ts(6), "message": {"role": "toolResult", "toolCallId": "tc2", "content": [{"type": "text", "text": "cat: missing.txt: No such file or directory"}], "isError": True}},
 {"type": "message", "id": "a4", "parentId": "r2", "timestamp": ts(7), "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "The file was missing, an error. I should report the failure clearly and offer the successful listing."}, {"type": "text", "text": "Hello! The listing worked and shows a README.md. The second command failed because missing.txt does not exist."}], "model": "test-model", "stopReason": "stop", "usage": usage(60)}},
]
open(p, "w").write("\n".join(json.dumps(l) for l in lines) + "\n")
PYEOF

start_pi() {
	# start_pi <extra args...>
	tmux kill-session -t "$SESSION" 2>/dev/null
	tmux new-session -d -s "$SESSION" -x 120 -y 44
	tmux send-keys -t "$SESSION" "cd $DIR && pi --no-extensions $* --session $SEED" Enter
	sleep 10
}

strip_volatile() {
	# Drop lines that legitimately differ between runs: zen's own notify
	# lines, the model-restore warning (order/timing), and the tmux hint.
	grep -vE ' zen: |Could not restore model|tmux extended-keys|^\s*$'
}

say "zen extension E2E (session $SESSION, dir $DIR)"

# ─── 1 + 2: clean start, --zen, filtered ──────────────────────────────────
start_pi "-e $EXT --zen"
if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive"; else bad "session alive"; fi
check_not_contains "no startup errors" "Extension.*(error|failed|cannot)|TypeError|ReferenceError"
check_not_contains "successful tool call hidden (\$ ls -la)" '$ ls -la'
check_contains "thinking collapsed to native label" "Thinking..."
check_not_contains "thinking content hidden" "The user wants a file listing"
check_contains "FAILED tool call stays visible" '$ cat missing.txt'
check_contains "error output visible" "cat: missing.txt: No such file or directory"
check_contains "conversation text intact" "Hello! The listing worked"

# ─── 3: /zen off restores the native transcript ───────────────────────────
send "/zen"
sleep 2
check_contains "tool call restored (\$ ls -la)" '$ ls -la'
check_contains "tool output restored" "README.md"
check_contains "thinking content restored" "The user wants a file listing"

# ─── 4: /zen on filters again ─────────────────────────────────────────────
send "/zen"
sleep 2
check_not_contains "successful tool call hidden again" '$ ls -la'
check_contains "failed call still visible after re-filter" '$ cat missing.txt'

# ─── 6: /reload keeps the filter (config re-apply) ──────────────────────────
send "/reload"
sleep 6
check_not_contains "still filtered after /reload" '$ ls -la'
check_contains "failed call visible after /reload" '$ cat missing.txt'

# ─── 7: one live turn stays hidden ───────────────────────────────────────────
send "use the bash tool to run 'echo zen-live-e2e', then answer with one short sentence"
sleep 30
check_not_contains "live tool call never appears" '$ echo zen-live-e2e'
check_contains "live answer appears" "echo zen-live-e2e"
if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive after the live turn"; else bad "session alive after the live turn"; fi

# ─── 5: parity — zen-off capture equals bare-pi capture ────────────────────
start_pi "-e $EXT --no-zen"
sleep 2
QUIET_OFF=$(tmux capture-pane -t "$SESSION" -p | strip_volatile > "$DIR/cap-zen-off.txt"; echo done)
tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x 120 -y 44
tmux send-keys -t "$SESSION" "cd $DIR && pi --no-extensions --session $SEED" Enter
sleep 10
tmux capture-pane -t "$SESSION" -p | strip_volatile > "$DIR/cap-bare.txt"
if diff -u "$DIR/cap-bare.txt" "$DIR/cap-zen-off.txt" > "$DIR/parity.diff" 2>&1; then
	ok "zen off = bare pi, line for line"
else
	bad "zen off = bare pi (see $DIR/parity.diff)"
	head -30 "$DIR/parity.diff"
fi

echo ""
echo "zen extension E2E: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
