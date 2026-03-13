#!/bin/bash
APP=com.microsoft.VSCode
case "$TERM_PROGRAM" in
ghostty) APP=com.mitchellh.ghostty ;;
Apple_Terminal) APP=com.apple.Terminal ;;
iTerm.app) APP=com.googlecode.iterm2 ;;
esac
alerter --message "$1" --title "Claude Code" --sender "$APP" --timeout 30 >/dev/null 2>&1 &
disown
