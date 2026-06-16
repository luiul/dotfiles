#!/bin/bash
# Deliver a macOS notification for Claude Code hooks.
#
# Uses osascript (UserNotifications framework) rather than the `alerter`
# binary: alerter's build relies on the legacy NSUserNotification API, which
# recent macOS (26.x) accepts without error but silently never delivers.
#
# Note: osascript banners support neither action buttons nor a controllable
# click target (clicking activates Script Editor), so there is no
# click-to-focus "Show" action. The maintained tools that could do that
# (alerter, terminal-notifier) are broken on current macOS / unmaintained.
#
# Usage: notify.sh "<message>"
# The current directory name is appended automatically as " in <dir>".

msg=$1
dir=$(basename "$PWD")
text="$msg in $dir"

# Escape backslashes and double quotes for the AppleScript string literal.
escaped=${text//\\/\\\\}
escaped=${escaped//\"/\\\"}

osascript -e "display notification \"$escaped\" with title \"Claude Code\" sound name \"default\"" >/dev/null 2>&1 &
