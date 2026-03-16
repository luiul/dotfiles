#!/bin/bash
APP=com.microsoft.VSCode
case "$TERM_PROGRAM" in
vscode) APP=com.microsoft.VSCode ;;
ghostty) APP=com.mitchellh.ghostty ;;
Apple_Terminal) APP=com.apple.Terminal ;;
iTerm.app) APP=com.googlecode.iterm2 ;;
esac
(
	result=$(alerter --message "$1" --title "Claude Code" --sender "$APP" --sound default --actions Show 2>/dev/null)
	if [ "$result" = "Show" ]; then
		open -b "$APP"
	fi
) &
disown
