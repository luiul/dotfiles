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

echo "Installing global npm packages..."
grep '^npm ' brew/Brewfile | sed 's/^npm "\(.*\)"/\1/' | xargs -I{} npm install -g {}

if ! command -v alerter &>/dev/null; then
	echo "Installing alerter..."
	curl -sL https://github.com/vjeantet/alerter/releases/latest/download/alerter -o /opt/homebrew/bin/alerter
	chmod +x /opt/homebrew/bin/alerter
fi

echo "Installing znap..."
[[ -d "$HOME/repos/znap" ]] || git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git "$HOME/repos/znap"

echo "Stowing dotfiles..."
# Pre-create directories that need file-level symlinks (--no-folding)
# to prevent stow from symlinking the entire directory
mkdir -p "$HOME/.snowflake"
for pkg in */; do
	stow --no-folding "$pkg"
done

echo "Cleaning up stale .zwc files..."
find "$DOTFILES_DIR" -name '*.zwc' -delete

echo "Configuring git hooks..."
git config core.hooksPath .githooks

if [[ ! -f "$DOTFILES_DIR/.env" ]]; then
	cp "$DOTFILES_DIR/example.env" "$DOTFILES_DIR/.env"
	echo "Created .env from example.env — fill in your values."
fi

echo "Done!"
