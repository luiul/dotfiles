#!/usr/bin/env bash
# gui-env-sync.sh: push selected secrets from ~/dotfiles/.env into the GUI
# session environment (launchd), so Dock-launched apps see them at process
# start.
#
# Why this exists: GUI apps read provider API keys from their process env
# exactly once, at provider init, before any login-shell env capture finishes.
# A var that only exists in .zshrc therefore arrives too late. (Original case:
# Zed, since removed.) launchctl setenv puts the var into the exec-level
# environment.
#
# Runs at login via ~/Library/LaunchAgents/com.luisaceituno.gui-env.plist.
# Add more variable names to VARS when a GUI app needs them.
set -euo pipefail

DOTFILES_ENV="${DOTFILES_ENV:-$HOME/dotfiles/.env}"
VARS=(AI_MODEL_ROUTER_API_KEY)

[[ -f "$DOTFILES_ENV" ]] || exit 0
set -a
source "$DOTFILES_ENV"
set +a

for name in "${VARS[@]}"; do
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    launchctl setenv "$name" "$value"
  fi
done
