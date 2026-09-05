#!/usr/bin/env bash
# gui-env-sync.sh: push selected secrets from ~/dotfiles/.env into the GUI
# session environment (launchd), so Dock-launched apps see them at process
# start.
#
# Why this exists: Zed reads provider API keys from its process env exactly
# once, at provider init. That happens before Zed's own login-shell env
# capture finishes, so a var that only exists in .zshrc arrives too late and
# the provider stays unauthenticated (Zed then hides its models from the
# picker). launchctl setenv puts the var into the exec-level environment.
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
