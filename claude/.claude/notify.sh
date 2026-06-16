#!/bin/bash
# Deliver a macOS notification for Claude Code hooks.
#
# Uses osascript (UserNotifications framework) rather than the `alerter`
# binary: alerter's build relies on the legacy NSUserNotification API, which
# recent macOS (26.x) accepts without error but silently never delivers.
#
# Note: osascript banners do not support action buttons, so there is no
# click-to-focus "Show" action. The banner appears under "Script Editor".

msg=$1

# Escape backslashes and double quotes for the AppleScript string literal.
escaped=${msg//\\/\\\\}
escaped=${escaped//\"/\\\"}

osascript -e "display notification \"$escaped\" with title \"Claude Code\" sound name \"default\"" >/dev/null 2>&1 &
