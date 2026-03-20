#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DOTFILES_DIR"

# Install Homebrew if not present
if ! command -v brew &>/dev/null; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

echo "Installing Homebrew packages..."
brew bundle --file=brew/Brewfile

echo "Stowing dotfiles..."
stow */

echo "Cleaning up stale .zwc files..."
find "$DOTFILES_DIR" -name '*.zwc' -delete

echo "Installing git hooks..."
cp "$DOTFILES_DIR/.githooks/pre-commit" "$DOTFILES_DIR/.git/hooks/pre-commit"
chmod +x "$DOTFILES_DIR/.git/hooks/pre-commit"

echo "Done!"
