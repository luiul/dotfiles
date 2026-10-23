#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Focus Command Center
# @raycast.mode silent
# @raycast.icon 🎛
# @raycast.packageName Command Center
# @raycast.description Focus the Ghostty window pinned as command center, or open and claim a new one.

# Focus (or open and claim) the Ghostty command-center window: the window
# whose focused tab carries the locked title below (cmd+shift+c / cmd+shift+x
# in Ghostty lock and clear a tab title; the lock overrides all shell title
# changes).
#
# One osascript run, all through Ghostty's OWN AppleScript dictionary: macOS
# culls the AX tree of backgrounded apps (luiul/dashkit#9), so a System
# Events window listing can miss the cc window and open a duplicate. Only
# the is-it-running check touches System Events.
#
# The open-only-if-missing rule is the whole point: the search re-checks a
# few times before concluding "missing", because opening a window is the one
# irreversible step. Claiming is `perform action set_tab_title` on the new
# surface, the same lock the cmd+shift+c keybind applies, and the claim is
# verified by reading the window title back: no keystroke injection, no
# waiting for the shell's first prompt, no dependence on what is focused.
#
# Cold start (Ghostty not running): `activate` both launches the app and
# makes it frontmost, and a background-launched Ghostty creates no window
# until it is frontmost, so the default window appears only after that
# activate. That default window (at $HOME) is the one to claim; opening
# another would duplicate it.

TITLE="🎛 cc"

result=$(osascript - "$TITLE" "$HOME" <<'APPLESCRIPT'
on run argv
	set ccTitle to item 1 of argv
	set homeDir to item 2 of argv

	tell application "System Events"
		set wasRunning to (exists process "ghostty")
	end tell

	tell application "Ghostty"
		activate
		if not wasRunning then
			repeat 20 times
				if (count of windows) is greater than 0 then exit repeat
				delay 0.25
			end repeat
			if (count of windows) is 0 then return "error"
			set w to front window
		else
			repeat 4 times
				set matches to (every window whose name is ccTitle)
				if (count of matches) is greater than 0 then
					activate window (item 1 of matches)
					return "focused"
				end if
				delay 0.25
			end repeat
			set w to new window with configuration {initial working directory:homeDir}
		end if
		perform action ("set_tab_title:" & ccTitle) on terminal 1 of w
		activate window w
		if (name of w) is not ccTitle then return "error"
		return "opened"
	end tell
end run
APPLESCRIPT
)

case "$result" in
  focused|opened)
    exit 0
    ;;
  *)
    # Unknown state: osascript failed (missing Automation permission,
    # Ghostty not answering) or the claim did not take. Nothing is
    # verified, so surface it instead of opening anything blind.
    osascript -e 'display notification "Could not focus or open the Ghostty command center." with title "Command Center"'
    exit 1
    ;;
esac
