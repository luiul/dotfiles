#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DOTFILES_DIR"

echo "Installing Homebrew packages..."
brew bundle --file=brew/Brewfile

echo "Stowing dotfiles..."
stow */

echo "Installing git hooks..."
cp "$DOTFILES_DIR/.githooks/pre-commit" "$DOTFILES_DIR/.git/hooks/pre-commit"
chmod +x "$DOTFILES_DIR/.git/hooks/pre-commit"

echo "Done!"
