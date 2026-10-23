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

	-- Bring Ghostty frontmost first, so the raise below can land and the
	-- fresh-window claim later sees a frontmost app. Then find and raise
	-- the cc window through Ghostty's OWN AppleScript dictionary, not
	-- System Events. The previous version listed windows through the AX
	-- tree, which macOS culls for backgrounded apps (luiul/dashkit#9):
	-- activate-before-list races the AX re-materialization, and a single
	-- 0.3s retry lost that race often enough to open a duplicate command
	-- center. Ghostty answers for its own windows without the AX tree, so
	-- that race is gone. A few short retries still run before concluding
	-- "missing": open is the last resort, so a transient app-event hiccup
	-- must not cost a duplicate window either.
	tell application "Ghostty"
		activate
		repeat 4 times
			set matches to (every window whose name is ccTitle)
			if (count of matches) is greater than 0 then
				activate window (item 1 of matches)
				return "focused"
			end if
			delay 0.25
		end repeat
	end tell
	return "missing"
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
