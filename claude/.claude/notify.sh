#!/bin/bash
# Deliver a macOS notification for Claude Code hooks, with click-to-focus.
#
# Posts via ClaudeNotifier.app (built by setup.sh from
# claudenotifier/ClaudeNotifier.applescript) so the banner is owned by our own
# app and clicking it focuses the terminal that launched Claude. The terminal
# is detected from $TERM_PROGRAM and passed as a bundle id.
#
# A compiled applet does not receive command-line argv, so we hand the message,
# title, and target bundle id to the app through a tab-separated "pending" file
# in the temp dir, then launch the app to consume it. See the applet source for
# the protocol.
#
# Falls back to a plain `osascript display notification` (no click-to-focus) if
# the app is absent, so notifications never silently break.
#
# Usage: notify.sh "<message>"
# The current directory name is appended automatically as " in <dir>".

msg=$1
dir=$(basename "$PWD")
text="$msg in $dir"
title="Claude Code"

# Detect the terminal that launched Claude, mapped to its bundle id.
case "$TERM_PROGRAM" in
	vscode)         bundle="com.microsoft.VSCode" ;;
	ghostty)        bundle="com.mitchellh.ghostty" ;;
	Apple_Terminal) bundle="com.apple.Terminal" ;;
	iTerm.app)      bundle="com.googlecode.iterm2" ;;
	*)              bundle="" ;;
esac

app="$HOME/Applications/ClaudeNotifier.app"

if [[ -d "$app" ]]; then
	# Hand the payload to the applet via the pending file, then launch it.
	# `-g` keeps the helper from stealing focus when it posts.
	printf '%s\t%s\t%s' "$text" "$title" "$bundle" > "${TMPDIR:-/tmp}claude-notifier-pending"
	open -g -a "$app" >/dev/null 2>&1 &
else
	# Fallback: plain banner, no click-to-focus (clicking opens Script Editor).
	escaped=${text//\\/\\\\}
	escaped=${escaped//\"/\\\"}
	osascript -e "display notification \"$escaped\" with title \"$title\" sound name \"default\"" >/dev/null 2>&1 &
fi
