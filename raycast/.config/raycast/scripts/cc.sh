#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Focus Command Center
# @raycast.mode silent
# @raycast.icon 🎛
# @raycast.packageName Command Center
# @raycast.description Focus the Ghostty command center, or create one if it is missing.

# Karabiner calls `cc.sh mark`; Raycast calls `cc.sh`.
# A locked tab title survives shell title changes and remains visible in background tabs.
TITLE="🎛 cc"
MODE="${1:-focus}"
case "$MODE" in focus|mark) ;; *) exit 2 ;; esac

# Serialize shortcut presses so two callers cannot create or mark two command centers.
mkdir -p "$HOME/.cache" || exit 1
LOCK="$HOME/.cache/cc.lock"
for ((attempt = 0; attempt < 100; attempt++)); do
  /usr/bin/shlock -p "$$" -f "$LOCK" && break
  sleep 0.05
done
if ((attempt == 100)); then exit 1; fi
trap 'rm -f "$LOCK"' EXIT

if result=$(osascript - "$MODE" "$TITLE" "$HOME" <<'APPLESCRIPT'
on run argv
	set mode to item 1 of argv
	set ccTitle to item 2 of argv
	set homeDir to item 3 of argv
	tell application "Ghostty"
		if mode is "mark" then
			if not running or not frontmost then error "Ghostty is not focused."
			set targetTab to selected tab of front window
			-- Mark first so a failed action cannot erase the previous designation.
			perform action ("set_tab_title:" & ccTitle) on focused terminal of targetTab
			if name of targetTab is not ccTitle then error "Could not mark the tab."
			repeat with w in windows
				repeat with t in tabs of w
					if id of t is not id of targetTab and name of t is ccTitle then
						perform action "set_tab_title:" on focused terminal of t
						if name of t is ccTitle then error "Could not clear the previous tab."
					end if
				end repeat
			end repeat
			return "marked"
		end if

		set wasRunning to running
		if not wasRunning then
			activate
			repeat 40 times
				if (count of windows) > 0 then exit repeat
				delay 0.1
			end repeat
			if (count of windows) is 0 then error "Ghostty did not open a window."
		end if
		-- Window titles hide background tabs. Search all tabs, including restored ones.
		repeat with w in windows
			repeat with t in tabs of w
				if name of t is ccTitle then
					activate
					focus focused terminal of t
					return "focused"
				end if
			end repeat
		end repeat
		if wasRunning then
			set w to new window with configuration {initial working directory:homeDir}
		else
			-- Use the startup window instead of creating a second one.
			set w to front window
		end if
		set targetTab to selected tab of w
		perform action ("set_tab_title:" & ccTitle) on focused terminal of targetTab
		if name of targetTab is not ccTitle then error "Could not mark the new tab."
		activate
		focus focused terminal of targetTab
		return "opened"
	end tell
end run
APPLESCRIPT
); then
  printf '%s %s\n' "$(date '+%F %T')" "$result" >> "$HOME/.cache/cc.log"
  case "$result" in focused|opened|marked) exit 0 ;; esac
fi
osascript -e 'display notification "Could not mark or open the Ghostty command center." with title "Command Center"'
exit 1
