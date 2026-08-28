#!/bin/bash
# cop-prompt-deliver.sh <worktree_path> <repo> <branch>
#
# Delivers $COP_PROMPT (set in wt's environment by `cop new --prompt`,
# coppice#23) to the worktree's VS Code window with pi already running it in
# the integrated terminal, on create and on reuse of an existing worktree
# alike. Two delivery paths:
#
# Fast path (AppleScript): `code -n` opens (or focuses, on reuse) the window,
# then the integrated terminal is driven directly: Terminal > New Terminal,
# paste `pi '<prompt>'`, Return. The terminal does not wait for VS Code's
# extension host, unlike a `runOn: folderOpen` task, which the task service
# only runs once it has task system info (measured on this machine: ~3.2s
# after the window is visible with ~90 extensions, vs ~1.5s on this path).
#
# Fallback (folderOpen task): when AppleScript is unavailable (no
# Accessibility permission for the calling terminal app, or VS Code not
# running yet) or the drive fails, write `.cop-prompt` plus a self-cleaning
# `.vscode/tasks.json` and let VS Code's folder-open task run pi instead.
# That path needs "task.allowAutomaticTasks": "on" and a trusted workspace;
# the fast path needs neither.
#
# Window matching relies on this machine's window.title setting
# ("${rootName} — ${activeRepositoryBranchName} — ${activeEditorShort}"): a
# created worktree shows up as a NEW window titled "<repo> — <branch>" after
# `code -n`; on reuse `code -n` focuses the already open window (VS Code
# dedupes folder windows) with that same title. Only the full "<repo> —
# <branch>" form is accepted: the bare "<repo>" title of a still-loading
# window is ambiguous when several windows of the same repo exist. Matching
# happens bash-side (UTF-8 safe) and the exact title crosses into AppleScript
# as a UTF-8 temp file: an env-var or argv string boundary mangles non-ASCII
# (the " — " separator arrived as MacRoman mojibake and the window lookup
# failed). The drive looks the window up BY NAME at click time: a 1-based
# index captured earlier races window-list reorders (observed: a VS Code
# window restore reshuffled indices mid-drive and the paste landed in an
# unrelated window).

set -u

WT="${1:?usage: cop-prompt-deliver.sh <worktree_path> <repo> <branch>}"
REPO="${2:?}"
BRANCH="${3:?}"
PROMPT="${COP_PROMPT:-}"

[ -n "$PROMPT" ] || exit 0
command -v pi >/dev/null 2>&1 || exit 0
command -v code >/dev/null 2>&1 || exit 0

# One window title per line. Fails (nonzero exit) when the calling app lacks
# Accessibility permission or VS Code is not running; both mean "use the
# fallback", so callers check the exit code, not just the output.
list_windows() {
	osascript <<'OSA' 2>/dev/null
tell application "System Events" to tell process "Code"
	set AppleScript's text item delimiters to linefeed
	return name of every window as text
end tell
OSA
}

# Fixed-string title match against this machine's window.title format:
# "<repo> — <branch>" followed by end or the " — <file>" segment. The branch
# segment is required, so a fresh window matches only once the git extension
# has loaded (~1s); that wait buys an unambiguous title.
title_matches() {
	case "$1" in
		"$REPO — $BRANCH" | "$REPO — $BRANCH — "*) return 0 ;;
	esac
	return 1
}

# The folderOpen-task delivery, what this hook used to do inline: the task
# reads the prompt, starts pi, and cleans up after itself.
write_task_fallback() {
	printf '%s' "$PROMPT" >"$WT/.cop-prompt"
	mkdir -p "$WT/.vscode"
	local tj="$WT/.vscode/tasks.json"
	if [ -f "$tj" ] && command -v jq >/dev/null 2>&1 && jq -e . "$tj" >/dev/null 2>&1; then
		# Merge into the repo's own (plain-JSON) tasks.json: drop any previous
		# task with our label, append a fresh one. The file predates us and
		# stays, so this command only deletes the prompt file, not tasks.json.
		local cmd='p=$(cat "${workspaceFolder}/.cop-prompt" 2>/dev/null) || exit 0; [ -n "$p" ] || exit 0; rm -f "${workspaceFolder}/.cop-prompt"; pi "$p"'
		local tmp
		tmp=$(mktemp)
		jq --arg cmd "$cmd" '
      .tasks = ((.tasks // []) | map(select(.label != "cop: pi prompt")) + [{
        label: "cop: pi prompt",
        type: "shell",
        command: $cmd,
        runOptions: { runOn: "folderOpen" },
        presentation: { reveal: "always", focus: true, panel: "dedicated" },
        problemMatcher: []
      }])' "$tj" >"$tmp" && mv "$tmp" "$tj" || echo "cop: could not merge into $tj; prompt left at $WT/.cop-prompt" >&2
	elif [ ! -f "$tj" ]; then
		# Fresh write: the task deletes this tasks.json again after reading the
		# prompt, so reopening the folder later runs nothing at all.
		cat >"$tj" <<'TASKS'
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "cop: pi prompt",
      "type": "shell",
      "command": "p=$(cat \"${workspaceFolder}/.cop-prompt\" 2>/dev/null) || exit 0; [ -n \"$p\" ] || exit 0; rm -f \"${workspaceFolder}/.cop-prompt\" \"${workspaceFolder}/.vscode/tasks.json\"; pi \"$p\"",
      "runOptions": { "runOn": "folderOpen" },
      "presentation": { "reveal": "always", "focus": true, "panel": "dedicated" },
      "problemMatcher": []
    }
  ]
}
TASKS
	else
		# tasks.json exists but isn't plain JSON (JSONC with comments, most
		# likely): jq can't merge into it; leave the prompt file and say so.
		echo "cop: $tj exists but is not plain JSON; prompt left at $WT/.cop-prompt" >&2
	fi
}

# Raise the window (looked up by exact name at click time, see the header
# comment), open a terminal via the menu bar (keybinding independent), paste
# the command from the clipboard (handles arbitrary prompt text, unlike
# per-character keystrokes), and hit Return. The clipboard's previous text is
# restored afterwards. The front-window guards turn a lost focus race (user
# clicked elsewhere mid-drive) into an error instead of a paste into the
# wrong window; the caller then falls back to the task delivery.
drive_window() {
	TITLE_FILE="$1" PROMPT_FILE="$2" osascript <<'OSA'
set t to read POSIX file (system attribute "TITLE_FILE") as «class utf8»
set p to read POSIX file (system attribute "PROMPT_FILE") as «class utf8»
tell application "System Events" to tell process "Code"
	set frontmost to true
	set targetWindow to first window whose name is t
	perform action "AXRaise" of targetWindow
	delay 0.3
	if name of front window is not t then error "front window mismatch"
	click menu item "New Terminal" of menu 1 of menu bar item "Terminal" of menu bar 1
end tell
delay 0.9
set savedClip to missing value
try
	set savedClip to the clipboard as text
end try
set the clipboard to ("pi " & quoted form of p)
set driveErr to missing value
try
	tell application "System Events" to tell process "Code"
		if name of front window is not t then error "front window mismatch"
		keystroke "v" using command down
		delay 0.15
		key code 36
	end tell
on error errMsg
	set driveErr to errMsg
end try
delay 0.2
if savedClip is not missing value then set the clipboard to savedClip
if driveErr is not missing value then error driveErr
OSA
}

# Probe AX permission (and a running VS Code) before opening anything: with
# no working probe there is no window detection at all, so go straight to the
# task delivery, written BEFORE the window opens, the ordering that has
# always worked.
TITLES_BEFORE=$(mktemp)
if ! list_windows >"$TITLES_BEFORE"; then
	write_task_fallback
	code -n "$WT"
	rm -f "$TITLES_BEFORE"
	exit 0
fi

code -n "$WT"

# Wait for the target window and remember its exact current title. Create
# case: a matching title that was not there before `code -n`. Reuse case: no
# new title (`code -n` focused the open window), so scan all titles for a
# match.
WIN_TITLE=""
deadline=$((SECONDS + 30))
while [ $SECONDS -lt $deadline ]; do
	TITLES_NOW=$(list_windows)
	while IFS= read -r title; do
		if ! grep -qxF -- "$title" "$TITLES_BEFORE" && title_matches "$title"; then
			WIN_TITLE=$title
			break
		fi
	done <<<"$TITLES_NOW"
	if [ -z "$WIN_TITLE" ]; then
		while IFS= read -r title; do
			if title_matches "$title"; then
				WIN_TITLE=$title
				break
			fi
		done <<<"$TITLES_NOW"
	fi
	[ -n "$WIN_TITLE" ] && break
	sleep 0.1
done
rm -f "$TITLES_BEFORE"

# pi PIDs currently alive, both lifecycle phases: at spawn the process is
# `node .../bin/pi <prompt>` (argv match), a second or two later pi rewrites
# its process title to bare `pi` (name match). Matching only the argv races
# the rewrite and can false-report a delivered prompt as failed.
pi_pids() {
	{ pgrep -x pi; pgrep -f "bin/pi "; } | sort -u
}

if [ -n "$WIN_TITLE" ]; then
	TITLE_FILE=$(mktemp)
	PROMPT_FILE=$(mktemp)
	printf '%s' "$WIN_TITLE" >"$TITLE_FILE"
	printf '%s' "$PROMPT" >"$PROMPT_FILE"
	PIDS_BEFORE=$(pi_pids)
	if drive_window "$TITLE_FILE" "$PROMPT_FILE"; then
		rm -f "$TITLE_FILE" "$PROMPT_FILE"
		# Confirm the drive actually delivered: a pi process appears that was
		# not alive before it AND runs inside the worktree. The cwd check
		# rejects unrelated pi sessions started at the same moment, and
		# drives that landed in the wrong window when the user pulled focus
		# mid-drive. Both fall through to the fallback below. Bounded at ~4s
		# (pi shows up within a second of the Return keystroke) so a failed
		# drive's fallback write stays inside the task system's config-change
		# pickup window.
		for _ in $(seq 1 40); do
			for pid in $(comm -13 <(printf '%s\n' "$PIDS_BEFORE") <(pi_pids)); do
				cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
				if [ "$cwd" = "$WT" ]; then
					exit 0
				fi
			done
			sleep 0.1
		done
	else
		rm -f "$TITLE_FILE" "$PROMPT_FILE"
	fi
fi

# The drive failed (or the window never showed): land the prompt via the
# folderOpen task instead. When the window did open this is still inside the
# task system's 10s config-change window, so the task is picked up.
write_task_fallback
exit 0
