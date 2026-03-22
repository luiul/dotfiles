#!/bin/bash
# Dump current Homebrew packages to Brewfile and commit if changed
set -euo pipefail

eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" || exit 0

DOTFILES="$(cd "$(dirname "$0")/.." && pwd)"
BREWFILE="$DOTFILES/brew/Brewfile"

brew bundle dump --file="$BREWFILE" --force

cd "$DOTFILES"
if git diff --quiet HEAD -- "$BREWFILE"; then
	exit 0
fi

git add "$BREWFILE"
git commit -m "chore: update Brewfile"
