#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Focus Command Center
# @raycast.mode silent
# @raycast.icon 🎛
# @raycast.packageName Command Center
# @raycast.description Focus the Ghostty window pinned as command center, or open and claim a new one.

# Focus (or open and claim) the Ghostty command-center window: the tab
# carrying the locked title below (cmd+shift+c / cmd+shift+x in Ghostty
# lock and clear a tab title; the lock overrides all shell title
# changes).
#
# One osascript run, all through Ghostty's OWN AppleScript dictionary: macOS
# culls the AX tree of backgrounded apps (luiul/dashkit#9), so a System
# Events window listing can miss the cc window and open a duplicate. Only
# the is-it-running check touches System Events.
#
# The match runs over TAB titles, not window names. A window's name is only
# its FOCUSED tab's title, and the cc window routinely holds several tabs:
# the moment another tab of the cc window is focused, the window name stops
# being the cc title, a window-name match finds nothing, and the open path
# fires a duplicate even though the cc tab is right there. Enumerating
# `every tab of every window` sees background tabs too, and goto_tab:N makes
# the cc tab the focused one again. (Verified against Ghostty 1.3.x:
# `terminal 1 of w` resolves to tab 1's terminal even with multiple tabs,
# and `perform action "goto_tab:N"` on it switches tabs.)
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
#
# Every invocation appends one line to ~/.cache/cc.log (result + when), so
# any "opened a duplicate" report can be checked against what the script
# actually saw instead of guessing.

TITLE="🎛 cc"
LOG="$HOME/.cache/cc.log"

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
			perform action ("set_tab_title:" & ccTitle) on terminal 1 of w
		else
			set w to missing value
			set tabIndex to 0
			repeat 4 times
				repeat with cand in windows
					set i to 0
					repeat with t in (every tab of cand)
						set i to i + 1
						if (name of t) is ccTitle then
							set w to cand
							set tabIndex to i
							exit repeat
						end if
					end repeat
					if w is not missing value then exit repeat
				end repeat
				if w is not missing value then exit repeat
				delay 0.25
			end repeat
			if w is not missing value then
				-- goto_tab unconditionally: a no-op when the cc tab is already
				-- focused, required when it is a background tab (its index says
				-- nothing about which tab is focused)
				perform action ("goto_tab:" & tabIndex) on terminal 1 of w
				activate window w
				repeat 8 times
					if (name of w) is ccTitle then exit repeat
					delay 0.1
				end repeat
				if (name of w) is ccTitle then return "focused"
				return "error"
			end if
			set w to new window with configuration {initial working directory:homeDir}
			perform action ("set_tab_title:" & ccTitle) on terminal 1 of w
		end if
		activate window w
		if (name of w) is not ccTitle then return "error"
		return "opened"
	end tell
end run
APPLESCRIPT
)

echo "$(date '+%F %T') $result" >> "$LOG"

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
