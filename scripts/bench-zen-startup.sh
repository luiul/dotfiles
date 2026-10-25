#!/bin/bash
# Startup and seeded-session wall-clock benchmark for the zen v2 effort
# (issues #67/#68).
#
# Measures, inside a detached tmux pane (real TUI, no LLM calls):
#
#   startup mode: pi launched with an empty editor, wall clock from launch
#   until the pane is stable (first full paint). The extension-load cost
#   of the measured variants shows up here.
#
#   seeded mode: pi launched with a crafted session jsonl (thinking + one
#   successful bash call + one failed bash call + text), wall clock from
#   launch until the pane is stable, plus the total rendered transcript
#   rows (tmux history capture, not just the viewport).
#
# Variants:
#   bare   pi --no-extensions
#   zen1   pi --no-extensions -e <zen.ts> --zen   (v1 filter, today's live state)
#   zen2   pi --no-extensions -e <zen.ts>          (added after issue #69 lands)
#
# Repeats are interleaved across variants so machine noise affects all
# variants equally. Reports median and MAD per variant.
#
# Usage: scripts/bench-zen-startup.sh startup|seeded bare zen1 [zen2 ...]
#
# The zen.json config is neither read into the measurement (variants pass
# an explicit --zen flag) nor written (no toggles are performed).

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/pi/.pi/agent/extensions/zen.ts"
MODE="${1:?usage: bench-zen-startup.sh startup|seeded <variant...>}"
shift
[ $# -ge 1 ] || { echo "usage: bench-zen-startup.sh startup|seeded <variant...>" >&2; exit 2; }

REPEATS="${REPEATS:-7}"
SESSION="ag-zen-bench-$$"
DIR=$(mktemp -d "${HOME}/.zen-bench-XXXXXX")   # NOT under /tmp: pi's session
                                               # dir naming derives from cwd
now_ms() { uv run --no-project python -c 'import time; print(int(time.time()*1000))'; }

variant_args() {
	case "$1" in
	bare) echo "--no-extensions" ;;
	zen1) echo "--no-extensions -e $EXT --zen" ;;
	zen2) echo "--no-extensions -e $EXT --zen" ;;
	*) echo "unknown variant: $1" >&2; return 1 ;;
	esac
}

# ─── seed (same shape as scripts/test-zen-extension.sh) ────────────────────────
SEED_FILE=""
seed_file() {
	local sessdir="$HOME/.pi/agent/sessions/--Users-luis-aceituno-$(basename "$DIR")--"
	mkdir -p "$sessdir"
	local seed="$sessdir/2026-10-26T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl"
	uv run --no-project python - "$seed" "$DIR" <<'PYEOF'
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
 {"type": "message", "id": "a4", "parentId": "r2", "timestamp": ts(7), "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "The file was missing, an error. I should report the failure clearly."}, {"type": "text", "text": "Hello! The listing worked and shows a README.md. The second command failed because missing.txt does not exist."}], "model": "test-model", "stopReason": "stop", "usage": usage(60)}},
]
open(p, "w").write("\n".join(json.dumps(l) for l in lines) + "\n")
PYEOF
	echo "$seed"
}

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null
	if [ "${KEEP:-0}" = 1 ]; then echo "KEEP: $DIR"; return; fi
	rm -rf "$DIR" "$HOME/.pi/agent/sessions/--Users-luis-aceituno-$(basename "$DIR")--"
}
trap cleanup EXIT

# Volatile lines that legitimately appear or change between captures
# while the pane is otherwise stable (model-restore warning, tmux hints,
# status-bar token counts).
strip_volatile() {
	grep -vE 'Could not restore model|tmux extended-keys|tokens'
}

# ─── one timed run ────────────────────────────────────────────────────────────
# run_once <variant>  → prints "<milliseconds> <rows>" to stdout
run_once() {
	local variant="$1"
	local args
	args=$(variant_args "$variant") || return 1

	local session_args=""
	if [ "$MODE" = "seeded" ]; then
		# Regenerate per run: pi moves the session file on start.
		session_args="--session $(seed_file)"
	fi

	tmux kill-session -t "$SESSION" 2>/dev/null
	tmux new-session -d -s "$SESSION" -x 120 -y 44

	local t0
	t0=$(now_ms)
	tmux send-keys -t "$SESSION" "cd $DIR && pi $args $session_args" Enter

	# Poll until the pane is stable and pi has painted its status bar
	# (context-usage percentage like "0.0%/1.0M" only exists once the
	# real TUI is up; the pre-paint shell + tmux warning alone must not
	# count as ready).
	local prev="" cur="" stable=0 elapsed=0
	while [ "$elapsed" -lt 60000 ]; do
		sleep 0.1
		cur=$(tmux capture-pane -t "$SESSION" -p | strip_volatile)
		if [ "$cur" = "$prev" ] &&
			printf '%s' "$cur" | grep -qE '[0-9]+([.][0-9]+)?%/' &&
			printf '%s' "$cur" | grep -qve '^[[:space:]]*$'; then
			stable=1
			break
		fi
		prev="$cur"
		elapsed=$(( $(now_ms) - t0 ))
	done

	local t1
	t1=$(now_ms)
	if [ "$stable" -ne 1 ]; then
		echo "TIMEOUT" >&2
		echo ""
		return
	fi

	local rows=0
	if [ "$MODE" = "seeded" ]; then
		# Total transcript rows from tmux history (uncapped by viewport).
		rows=$(tmux capture-pane -t "$SESSION" -p -S -2000 | strip_volatile | grep -cve '^[[:space:]]*$')
	fi
	tmux kill-session -t "$SESSION" 2>/dev/null
	echo "$((t1 - t0)) $rows"
}

# ─── interleaved repeats ──────────────────────────────────────────────────────
# macOS /bin/bash is 3.2 (no associative arrays): one results file per variant.
RESULTS_DIR="$DIR/results"
mkdir -p "$RESULTS_DIR"
for v in "$@"; do : > "$RESULTS_DIR/$v"; done

for ((r = 1; r <= REPEATS; r++)); do
	for v in "$@"; do
		run_once "$v" >> "$RESULTS_DIR/$v"
	done
done

# ─── report ───────────────────────────────────────────────────────────────────
stats() { # $1 = results file
	uv run --no-project python - "$1" <<'PYEOF'
import statistics, sys
raw = open(sys.argv[1]).read().splitlines()
vals = sorted(int(l.split()[0]) for l in raw if l.strip() and not l.startswith("TIMEOUT"))
rows = [int(l.split()[1]) for l in raw if len(l.split()) == 2 and not l.startswith("TIMEOUT")]
if not vals:
    print("n/a")
else:
    med = statistics.median(vals)
    mad = statistics.median(abs(v - med) for v in vals)
    line = f"{med:.0f}ms (MAD {mad:.0f}, n={len(vals)})"
    if rows:
        line += f"  median {statistics.median(rows):.0f} rows"
    print(line)
PYEOF
}

echo "zen benchmark: mode=$MODE repeats=$REPEATS pane=120x44"
echo ""
for v in "$@"; do
	printf "%-6s %s\n" "$v" "$(stats "$RESULTS_DIR/$v")"
done
