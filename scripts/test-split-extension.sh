#!/bin/bash
# E2E smoke test for the split extension (extensions/split/ directory extension).
#
# Runs a real pi in a detached tmux session (fullscreen mode comes from
# settings.json) with ONLY the split extension loaded (--no-extensions -e),
# started on a SEEDED session (two 50-line turns, crafted jsonl) so the
# sticky-scroll assertions are deterministic and cost no extra LLM calls,
# then asserts against the rendered pane:
#   1. clean start, no extension errors
#   2. the three right panels compose (forced on per-panel, independent of
#      the saved startup defaults): Thinking + Tools + File Changes headers,
#      divider
#   2.5 update notices (--split-fake-updates, deterministic): "Update Available",
#      "Package Updates Available", "Skill conflicts", and "What's New" as Tools
#      panel event rows and as framed blocks at the response doc top, plus the
#      persistent footer status line — no layout state drops them
#   3. /split-width recomposes at a new left share
#   4. a real agent turn (two write calls, one with a long nested path) lands
#      in the Tools and File Changes panels, and the long path WRAPS
#      (hanging indent) instead of truncating
#   4. the sticky user prompt bar (split-sticky.ts): pins the seeded prompt
#      while it is scrolled above the view, walks back a turn on PageUp,
#      hides after jump-to-top, /split-toggle-sticky off removes it
#   5. /split-toggle-response-only reports response-only mode
#   5.5 no-information-loss (2026-10-24): the seeded !gurl block (exit 127),
#      the seeded skill turn, and the seeded branch summary survive the split —
#      bash in the response doc (trim mode), skill + branch summary as Tool
#      Usage event rows; a LIVE !echo and !!echo land in the doc too
#      (user_bash + the per-frame leaf walk, no extension events involved)
#   5.6 /split-changelog (2026-10-24 review): pi's /changelog output is
#      transcript-only, so response-only mode would show nothing when the
#      user asks for the changelog — the command appends the running version's
#      full entry as a doc-bottom block (visible at the follow-end position)
#   5.7 /split-toggle-right: hide the whole right column at once, re-show restores
#      the exact panel set, and the above-editor filechanges widget stays hidden
#      while the hidden set includes the files panel
#   6. /split-toggle off restores the bare layout
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
EXT="$HOME/dotfiles/pi/.pi/agent/extensions/split"
SESSION="split-e2e-$$"
DIR=$(mktemp -d "${HOME}/.split-e2e-XXXXXX")   # NOT under /tmp: tracker hard-excludes temp dirs
git -C "$DIR" init -q                     # a repo, so entries carry repoState (untracked)
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
	rm -rf "$SESSDIR" 2>/dev/null
}
trap cleanup EXIT

say "── split extension E2E (session $SESSION, dir $DIR)"

# Deterministic long history for the sticky bar tests: a seeded session with
# two 50-line turns, placed in pi's sessions dir for this cwd (cwd must match
# $DIR so the tracker's session-file glob still finds it; pi adopts a seeded
# file in place, unlike an EMPTY precreated file which it moves — that flow
# is the known /share pitfall).
SESSDIR="$HOME/.pi/agent/sessions/--Users-luis.aceituno-.split-e2e-$$--"
mkdir -p "$SESSDIR"
SEED="$SESSDIR/2026-10-19T00-00-00-000Z_deadbeef-0000-4000-8000-000000000000.jsonl"
python3 - "$SEED" "$DIR" <<'PYEOF'
import json, sys
p, cwd = sys.argv[1], sys.argv[2]
ts = lambda i: f"2026-10-19T00:00:{i:02d}.000Z"
usage = lambda n: {"input": 100, "output": n, "cacheRead": 0, "cacheWrite": 0,
	"totalTokens": 100 + n, "cost": {"input": 0.001, "output": 0.001,
	"cacheRead": 0, "cacheWrite": 0, "total": 0.002}}
lines = [
 {"type": "session", "version": 3, "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "timestamp": ts(0), "cwd": cwd},
 {"type": "model_change", "id": "m1", "parentId": None, "timestamp": ts(0), "provider": "test", "modelId": "test-model"},
 {"type": "message", "id": "u1", "parentId": "m1", "timestamp": ts(1), "message": {"role": "user", "content": [{"type": "text", "text": "seed prompt one: tell me about alpha"}]}},
 {"type": "message", "id": "u2", "parentId": "u1", "timestamp": ts(2), "message": {"role": "assistant", "content": [{"type": "text", "text": "\n".join(f"seed turn one line {n:02d}" for n in range(1, 51))}], "model": "test-model", "stopReason": "stop", "usage": usage(50)}},
 {"type": "message", "id": "u2b", "parentId": "u2", "timestamp": ts(2), "message": {"role": "assistant", "content": [{"type": "text", "text": "seed answer one continuation line"}], "model": "test-model", "stopReason": "stop", "usage": usage(1)}},
 {"type": "message", "id": "s1", "parentId": "u2b", "timestamp": ts(3), "message": {"role": "user", "content": [{"type": "text", "text": "<skill name=\"seeded-skill\" location=\"/skills/seeded/SKILL.md\">\nSeeded skill prompt body for the panel event row.\n</skill>\n\nseed prompt attached to a skill"}]}},
 {"type": "branch_summary", "id": "br1", "parentId": "s1", "timestamp": ts(4), "summary": "Seeded branch summary for the panel event row.", "fromId": "m1"},
 {"type": "message", "id": "u3", "parentId": "br1", "timestamp": ts(5), "message": {"role": "user", "content": [{"type": "text", "text": "seed prompt two: tell me about beta"}]}},
 {"type": "message", "id": "u4", "parentId": "u3", "timestamp": ts(6), "message": {"role": "assistant", "content": [{"type": "text", "text": "\n".join(f"seed turn two line {n:02d}" for n in range(1, 51))}], "model": "test-model", "stopReason": "stop", "usage": usage(50)}},
 {"type": "message", "id": "b1", "parentId": "u4", "timestamp": ts(7), "message": {"role": "bashExecution", "command": "gurl", "output": "/bin/bash: gurl: command not found\n", "exitCode": 127, "cancelled": False, "truncated": False, "fullOutputPath": None, "timestamp": 1697700000000, "excludeFromContext": False}},
]
open(p, "w").write("\n".join(json.dumps(l) for l in lines) + "\n")
PYEOF

tmux new-session -d -s "$SESSION" -x 170 -y 46
tmux send-keys -t "$SESSION" "cd $DIR && pi --no-extensions --thinking off --split-fake-updates -e $EXT --session $SEED" Enter
sleep 12
capture

# 1. clean start
check_not_contains "no startup errors" "Extension.*(error|failed|cannot)|TypeError|ReferenceError"
if tmux list-sessions 2>/dev/null | grep -q "$SESSION"; then ok "session alive"; else bad "session alive"; fi

# 2. Force the three right panels on, INDEPENDENT of the saved startup
#    defaults in ~/.pi/agent/split.json (the user's live saved layout may
#    legitimately have panels off, e.g. all off with trim saved on). Per-panel
#    toggles, each sent ONLY when that panel's header is missing: a blind
#    toggle would turn a present panel OFF, and the master /split-toggle
#    would apply the saved defaults (which may be all panels off).
ensure_panel() {
	# ensure_panel <header> <command>
	local header=$1 cmd=$2
	capture
	if echo "$CAP" | grep -q "$header"; then
		say "── $header already on screen (saved startup default)"
	else
		tmux send-keys -t "$SESSION" "$cmd" Enter
		sleep 2
	fi
}
ensure_panel "Thinking" "/split-toggle-thinking"
ensure_panel "Tools" "/split-toggle-tools"
ensure_panel "File Changes" "/split-toggle-files"
capture
check_contains "thinking panel header" "Thinking"
check_contains "tools panel header" "Tools"
check_contains "file changes panel header" "File Changes"
# The divider is blank at rest (2026-10-20 decision: no ink, and a full-height
# box-drawing column renders with artifacts in the VS Code terminal). Assert
# no dense │ column anywhere: scattered transcript glyphs are fine, a rail is
# not (before this change the divider and the panel scrollbars were rails).
DENSE=$(tmux capture-pane -t "$SESSION" -p | python3 -c '
import sys, collections
cnt = collections.Counter()
for line in sys.stdin:
    for col, ch in enumerate(line.rstrip("\n")):
        if ch == "│": cnt[col] += 1
print(max(cnt.values()) if cnt else 0)
')
if [ "$DENSE" -lt 10 ]; then ok "divider blank at rest (max │ density $DENSE)"; else bad "divider blank at rest (max │ density $DENSE)"; fi

# 3. /split-width recomposes. The "Left column: 45%" notify is invisible
#    while response-only is active (the extension's documented notify blind
#    spot), so assert the divider actually moved instead: the divider column
#    is located by the Thinking panel header (" Thinking ────": the header's
#    leading space is the panel's left edge, the divider sits one column
#    further left; at 45% of 170 cols ≈ column 76).
divider_col() {
	tmux capture-pane -t "$SESSION" -p | python3 -c '
import sys, re
for line in sys.stdin:
    m = re.search(r"Thinking ─────", line)
    if m:
        print(m.start() - 2)
        sys.exit(0)
print(-1)
'
}
DIV0=$(divider_col)

# 2.5 session-event rows rebuilt into the Tools panel (no-information-
# loss policy): the seeded skill turn and branch summary must appear as
# panel event rows, and the seeded skill turn's RAW <skill block must never
# show in the left column. (Runs here because capture_right needs divider_col.)
capture_right
check_in_right "skill turn logged as a panel event row" "skill: seeded-skill"
check_in_right "branch summary logged as a panel event row" "branch summary"
# Update notices (split-updates.ts, forced by --split-fake-updates so this is
# deterministic): all three must be Tools panel event rows, and the footer
# status line must list them (the one surface visible in every layout state).
# The deferred check fires ~1.5s after session start, long before this capture.
check_in_right "skill conflicts notice is a Tools panel event row" "Skill conflicts"
check_in_right "changelog notice is a Tools panel event row" "What's New \\(999\\.0\\.0\\)"
check_in_right "pi update notice is a Tools panel event row" "Update Available"
check_in_right "package updates notice is a Tools panel event row" "Package Updates Available"
check_contains "footer status lists all pending notices" "updated to 999.0.0 · pi 999.0.0 available · 2 package updates · 1 skill conflict"
check_not_contains "raw skill block never rendered in the left column" "<skill"

tmux send-keys -t "$SESSION" "/split-width 45" Enter
sleep 2
DIV1=$(divider_col)
if [ "$DIV1" -ge 70 ] && [ "$DIV1" -le 82 ]; then ok "divider moved to 45% (col $DIV0 → $DIV1)"; else bad "divider at 45% (got col $DIV1, was $DIV0)"; fi

# 3.5 sticky user prompt bar (split-sticky.ts, VS Code sticky scroll) —
# runs on the SEEDED session (deterministic 2-turn history, no LLM needed)
# while provably idle, before any agent turn. The seeded transcript is far
# taller than the viewport, so while following the end the bar pins the
# prompt that owns the top visible line; one PageUp walks the pinned prompt
# back to the previous turn; ctrl+home hides it (the prompt itself is then
# on screen); ctrl+end re-pins it; /split-toggle-sticky off removes it for real.
top_rows() {
	tmux capture-pane -t "$SESSION" -p | head -8
}
tmux send-keys -t "$SESSION" "/split-toggle-sticky on" Enter
sleep 2
TOP=$(top_rows)
if echo "$TOP" | grep -q "▌" && echo "$TOP" | grep -q "seed prompt two"; then
	ok "sticky bar pins the owning prompt at the top"
else
	bad "sticky bar pins the owning prompt at the top"
fi
if echo "$TOP" | grep -q "seed prompt one"; then
	bad "sticky bar pins the LATEST turn's prompt, not an old turn"
else
	ok "sticky bar pins the LATEST turn's prompt, not an old turn"
fi
tmux send-keys -t "$SESSION" -l "$(printf '\033[5~')"   # PageUp: into seed turn one
sleep 2
TOP=$(top_rows)
if echo "$TOP" | grep -q "▌" && echo "$TOP" | grep -q "seed prompt one"; then
	ok "pinned prompt walks turn by turn when scrolling"
else
	bad "pinned prompt walks turn by turn when scrolling"
fi
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5H')"   # ctrl+home: to the top
sleep 2
TOP=$(top_rows)
if echo "$TOP" | grep -q "▌"; then
	bad "sticky bar hides at the transcript top"
else
	ok "sticky bar hides at the transcript top"
fi
capture
if echo "$CAP" | grep -q "seed prompt one"; then
	ok "the actual prompt is on screen after jump-to-top"
else
	bad "the actual prompt is on screen after jump-to-top"
fi
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5F')"   # ctrl+end: follow the end
sleep 2
tmux send-keys -t "$SESSION" "/split-toggle-sticky off" Enter
sleep 2
capture
if echo "$CAP" | grep -q "▌"; then
	bad "sticky off removes the pinned bar"
else
	ok "sticky off removes the pinned bar"
fi
tmux send-keys -t "$SESSION" "/split-toggle-sticky on" Enter
sleep 2

# 5. response-only mode — test while provably IDLE (before the agent turn):
# a command sent while a turn is still streaming gets queued as a follow-up
# prompt to the model instead of executing. Toggles are direction-agnostic:
# the saved startup config may start in either state, so assert the status
# hint appears and cycles ("left: response only" <-> "left: full transcript",
# both visible in either view; the notify itself is blind-spotted).
tmux send-keys -t "$SESSION" "/split-toggle-response-only" Enter
sleep 2
capture
HINT1=$(echo "$CAP" | grep -oE "left: (response only|full transcript)" | head -1)
if [ -n "$HINT1" ]; then ok "trim toggle 1 shows hint ($HINT1)"; else bad "trim toggle 1 shows hint"; fi
tmux send-keys -t "$SESSION" "/split-toggle-response-only" Enter
sleep 2
capture
HINT2=$(echo "$CAP" | grep -oE "left: (response only|full transcript)" | head -1)
if [ -n "$HINT2" ] && [ "$HINT2" != "$HINT1" ]; then ok "trim toggle 2 cycles hint ($HINT2)"; else bad "trim toggle 2 cycles hint (got '$HINT2', had '$HINT1')"; fi

# 5.5 no-information-loss: with response-only FORCED on, the left column is
# the response doc — the seeded !gurl block must be right there (the native
# transcript is not rendered in this mode), proving bash blocks survive
# trim mode. Then run a LIVE !echo and !!echo and watch them land too
# (user_bash handler + per-frame leaf walk).
tmux send-keys -t "$SESSION" "/split-toggle-response-only on" Enter
sleep 2
capture
check_contains "seeded bash block visible in response-only mode" '\$ gurl'
check_contains "seeded bash exit status visible" "command not found"
check_contains "seeded bash exit code visible" "\(exit 127\)"
# Block divider placement (2026-10-20, fourth design): the divider exists
# only between CONSECUTIVE response blocks (answers merge visually) — never
# around prompts or bash blocks. The seeded continuation sits mid-doc after
# the 50-line turn-one answer, so jump to the top and page down to it. The
# stroke must have the answer above (one blank row between) and the
# continuation below. Bash frames and the sticky bar separator also match
# the stroke pattern; the answer/continuation windows disambiguate.
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5H')"   # ctrl+home: doc top
sleep 2
capture
# Update notices ride the doc TOP in response-only mode (pi's own blocks
# live in the native transcript, which this view replaces). The changelog
# title "What's New (999.0.0)" also shows in the compact panel row, so the
# doc-top proof greps its BODY text, which only the doc block carries; the
# other fixtures' fake markers likewise only exist in the doc blocks, so a
# whole-pane grep is left-column-only by construction.
check_contains "update notice block visible at the doc top" "999.0.0"
check_contains "changelog notice block visible at the doc top" "Updated to v999.0.0"
check_contains "skill conflicts block visible at the doc top" "fake-skill"
# Block divider: page down until the mid-doc divider is on screen. The
# startup notice blocks' total height varies with the fixture (four notices
# now), so a fixed number of pages is brittle; 4 attempts cover the seeded
# doc, and further pages clamp at the end harmlessly (overscroll contain).
PLACEMENT="bad:not-started"
for _attempt in 1 2 3 4; do
	tmux send-keys -t "$SESSION" NPage   # page down toward the continuation
	sleep 2
	capture
	PLACEMENT=$(echo "$CAP" | DIV_COL="$(divider_col)" python3 -c '
import os, re, sys
# Left-column region only: the right column shares full-width rows, so the
# "blank row above the divider" contract (a DOC property) must be judged on
# the doc columns alone. With the right column visible, the row above the
# divider stroke can carry panel ink (e.g. a Tools event row), and a
# full-line blank test fails spuriously; the four-notice fixture stack
# (split-updates.ts) shifted the divider onto exactly such a row.
div = os.environ.get("DIV_COL", "-1")
col = int(div) if div.lstrip("-").isdigit() and int(div) > 0 else 80
left = lambda s: s[:col]
lines = sys.stdin.read().split("\n")
for i, l in enumerate(lines):
    if re.match(r"^─{40,}", left(l)):
        above = "\n".join(left(x) for x in lines[max(0, i - 8) : i])
        below = "\n".join(left(x) for x in lines[i + 1 : i + 6])
        # "seed answer one" (prefix) not the full continuation text: the update
        # notice blocks (split-updates.ts) sit at the doc top, so the divider
        # lands near the viewport bottom after one page down and the
        # continuation line can be cut mid-word by the screen edge. The prefix
        # is unique (answer lines read "seed turn one line N").
        if (
            "seed turn one line" in above
            and (not left(lines[i - 1]).strip() if i > 0 else False)
            and "seed answer one" in below
        ):
            print("ok")
            sys.exit(0)
        # else: keep scanning — bash frames and the sticky bar separator
        # also render full-width ─ rows.
print("bad:no-divider-between-answers-and-continuation")
')
	if [ "${PLACEMENT%%:*}" = "ok" ]; then break; fi
done
if [ "${PLACEMENT%%:*}" = "ok" ]; then ok "block divider between consecutive response blocks"; else bad "block divider placement ($PLACEMENT)"; fi
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5F')"   # ctrl+end: back to the tail
sleep 2
# 5.6 /split-changelog: back to the tail FIRST (the divider loop left the
# view mid-doc), then run the command — the doc-bottom block it appends shows
# its TAIL first (native parity: pi's own /changelog appends at the transcript
# end too), so page up to reach the block's title and pointer line. Six
# bounded attempts: at this test's 45% left width the real changelog lines
# WRAP, so the block is ~130 rendered rows tall and its top is ~4 pages up.
# Entry text itself varies with the installed pi version, so assert on the
# title/pointer only.
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5F')"   # ctrl+end: back to the tail
sleep 2
tmux send-keys -t "$SESSION" "/split-changelog" Enter
sleep 2
CHLOG="bad:not-seen"
for _c in 1 2 3 4 5 6; do
	capture
	if echo "$CAP" | grep -qE "Changelog \\(|Older entries:"; then
		CHLOG="ok"
		break
	fi
	tmux send-keys -t "$SESSION" PPage
	sleep 2
done
if [ "$CHLOG" = "ok" ]; then ok "on-demand changelog block visible (/split-changelog)"; else bad "on-demand changelog block visible (/split-changelog) ($CHLOG)"; fi
capture
check_contains "on-demand changelog block links older entries" "Older entries:"
tmux send-keys -t "$SESSION" -l "$(printf '\033[1;5F')"   # ctrl+end: follow the end again for the bash step
sleep 2
tmux send-keys -t "$SESSION" "!echo split-e2e-live-bash" Enter
sleep 3
capture
check_contains "live !echo block in the doc" '\$ echo split-e2e-live-bash'
check_contains "live !echo output in the doc" "split-e2e-live-bash"
tmux send-keys -t "$SESSION" "!!echo split-e2e-quiet-bash" Enter
sleep 3
capture
check_contains "live !!echo block in the doc (dim, not dropped)" '\$ echo split-e2e-quiet-bash'
check_contains "live !!echo output in the doc" "split-e2e-quiet-bash"
# Restore the pre-5.5 trim state so the rest of the script runs as before
# ("on" forced response-only; a single toggle returns to full transcript).
if [ "$HINT2" != "left: full transcript" ]; then
	tmux send-keys -t "$SESSION" "/split-toggle-response-only" Enter
	sleep 2
fi

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
# #45 quiet tool rows: a settled write renders "  write" (empty mark
# gutter, plain name); an active one still shows "● write".
check_contains "tool usage records the write call" "(●|  ) write"
capture_right
check_in_right "file changes wraps the long path" "deeply/nested"
check_in_right "file changes lists both files" "\(\+1/-0\)"
# Regression (2026-10-16): rows used to overflow the section width and get
# clipped mid-word at the panel edge ("untracked" rendered "untrac"). The
# repo state must render whole. (The 8-char-fragment wrap bug is pinned by
# scripts/test-split-files.ts.)
check_in_right "repo state renders whole (no edge clipping)" "untracked"
# Both write calls in the tool panel (compact: adjacent lines, no blanks).
# Rows start at the panel's left edge, so anchor: "  write" (settled) or
# "● write" (still active).
WRITES=$(echo "$CAP_R" | grep -cE "^(●|  ) write")
if [ "$WRITES" -ge 2 ]; then ok "tools panel lists both writes"; else bad "tools panel lists both writes (found $WRITES of 2)"; fi
# #43 reverted (user decision 2026-10-20): the panels follow the end like
# the left column, so the OLDER write (test.txt) is the first tool row and
# the newest sits at the bottom.
FIRST_WRITE=$(echo "$CAP_R" | grep -E "^(●|  ) write" | head -1)
if echo "$FIRST_WRITE" | grep -q "test.txt"; then ok "tools panel oldest first, following the end like the left column"; else bad "tools panel order (got: $FIRST_WRITE)"; fi
# Files panel flipped for consistency (2026-10-20): oldest changed file
# above newest. The tracker's kind word is "created"; tools rows start
# with "  write", so "created <path>" anchors on file rows only.
FC_TT=$(echo "$CAP_R" | grep -nE "created +test\.txt" | head -1 | cut -d: -f1)
FC_DN=$(echo "$CAP_R" | grep -nE "created +deeply/nested" | head -1 | cut -d: -f1)
if [ -n "$FC_TT" ] && [ -n "$FC_DN" ] && [ "$FC_TT" -lt "$FC_DN" ]; then ok "files panel oldest first, following the end like the left column"; else bad "files panel order (test.txt at line $FC_TT, deeply/nested at line $FC_DN)"; fi

# Let the turn fully settle before the next command (see the trim note above).
sleep 10

# 5.7 /split-toggle-right: hide the whole right column at once (left view keeps the
# full width), then re-show restores the exact panel set.
tmux send-keys -t "$SESSION" "/split-toggle-right" Enter
sleep 2
capture
check_contains "right column off notify" "Right column off"
check_not_contains "panels gone after split-toggle-right off" "Thinking idle|No tools called yet|No changes yet"
# The above-editor filechanges widget must NOT come back with the hide: the
# goal is a clean conversation, so "Changes last round" stays out of the left
# column while the hidden set included the files panel (write turn settled above).
check_not_contains "filechanges widget stays hidden while the right column is off" "Changes last round"
tmux send-keys -t "$SESSION" "/split-toggle-right" Enter
sleep 2
capture
check_contains "right column on notify" "Right column on"
capture_right
check_in_right "re-show restores the thinking panel" "Thinking"
check_in_right "re-show restores the tools panel" "Tools"

# 6. split off = bare layout
tmux send-keys -t "$SESSION" "/split-toggle" Enter
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
	bad "tracker session-set entry persisted (NEWEST='$NEWEST'; files: $(ls "$HOME/.pi/agent/sessions/--Users-luis.aceituno-.split-e2e-"*/*.jsonl 2>/dev/null | tr '\n' ' '))"
fi

say ""
say "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
