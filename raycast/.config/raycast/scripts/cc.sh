#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Focus Command Center
# @raycast.mode silent
# @raycast.icon 🎛
# @raycast.packageName Command Center
# @raycast.description Focus the Ghostty window pinned as command center, or open and claim a new one.

# Focus (or open and claim) the Ghostty command-center window.
#
# The command center is the Ghostty window whose focused tab carries the
# locked title below. Lock it with cmd+shift+c in Ghostty (set_tab_title
# keybind): the lock overrides all shell title changes and covers every
# split in the tab. This script then finds it by that exact title.

TITLE="🎛 cc"

# Returns one of: "focused" (a claimed window was raised), "launched"
# (Ghostty was not running and has just been started, its default window
# is at $HOME and still unclaimed), or "missing" (Ghostty runs but no
# window carries the title).
find_cc_window() {
  osascript - "$TITLE" <<'APPLESCRIPT'
on run argv
	set ccTitle to item 1 of argv

	tell application "System Events"
		set wasRunning to (exists process "ghostty")
	end tell
	if not wasRunning then
		launch application "Ghostty"
		repeat 20 times
			tell application "System Events"
				if (exists process "ghostty") then exit repeat
			end tell
			delay 0.25
		end repeat
		return "launched"
	end if

	-- Activate before listing: macOS culls the AX tree of backgrounded
	-- apps, so a backgrounded listing can miss real windows
	-- (luiul/dashkit#9, same fix as dashkit's OpenGhostty).
	activate application "Ghostty"

	tell application "System Events"
		tell process "ghostty"
			set matches to (every window whose name is ccTitle)
			if (count of matches) is 0 then
				-- Never conclude "missing" on one listing: activation can take
				-- a beat to re-materialize the AX tree (luiul/dashkit#9), and
				-- opening a window when one exists is the failure mode this
				-- script exists to prevent. Re-list after a short delay.
				delay 0.3
				set matches to (every window whose name is ccTitle)
				if (count of matches) is 0 then return "missing"
			end if
			perform action "AXRaise" of (item 1 of matches)
			return "focused"
		end tell
	end tell
end run
APPLESCRIPT
}

# True when the focused Ghostty tab is a fresh home shell: its window title
# is "~" (set by the zsh hook in ~/.zsh_config/title.zsh on the first prompt).
fresh_home_tab_focused() {
  osascript -e '
tell application "System Events"
	if frontmost of process "ghostty" is not true then return "no"
	tell process "ghostty"
		set w to (first window whose value of attribute "AXMain" is true)
		if name of w is "~" then return "yes"
		return "no"
	end tell
end tell' | grep -q yes
}

# Press cmd+shift+c in the focused tab to lock the command-center title.
claim_focused_tab() {
  osascript -e 'tell application "System Events" to keystroke "c" using {command down, shift down}'
}

notify_manual() {
  osascript -e 'display notification "Press cmd+shift+c in the new Ghostty window to claim it as command center." with title "Command Center"'
}

notify_failed() {
  osascript -e 'display notification "Could not check or open Ghostty windows. Nothing was opened." with title "Command Center"'
}

state=$(find_cc_window)

case "$state" in
  focused)
    # A claimed window existed and was raised.
    exit 0
    ;;
  missing)
    # The listing (run twice) confirmed no claimed window exists. Only
    # now is it safe to open one, at $HOME.
    if ! osascript -e 'tell application "Ghostty" to new window with configuration {initial working directory:"'"${HOME}"'"}' >/dev/null 2>&1; then
      notify_failed
      exit 1
    fi
    ;;
  launched)
    # Ghostty was not running and has just been started; its default
    # window (at $HOME) is the one to claim. Opening another would
    # duplicate it.
    ;;
  *)
    # Unknown state: osascript failed (error, missing Automation or
    # Accessibility permission). Opening blind could stack a duplicate
    # window, so surface the failure and do nothing.
    notify_failed
    exit 1
    ;;
esac

# Wait for the fresh home shell's first prompt (title "~"), then lock the
# title automatically. Bail with a notification if that never settles, so
# the user claims manually instead of the keystroke landing somewhere else.
claimed=0
for _ in {1..12}; do
  sleep 0.25
  if fresh_home_tab_focused; then
    claimed=1
    break
  fi
done

if [[ $claimed == 1 ]]; then
  claim_focused_tab
else
  notify_manual
fi
