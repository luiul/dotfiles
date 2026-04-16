#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DOTFILES_DIR"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

step() { echo -e "\n${BLUE}==>${RESET} $1"; }
ok() { echo -e "  ${GREEN}✓${RESET} $1"; }
skip() { echo -e "  ${YELLOW}⊘${RESET} $1 (skipped)"; }

confirm() {
	read -rp "$1 [Y/n] " answer
	case "$answer" in
		[nN]*) return 1 ;;
		*) return 0 ;;
	esac
}

# --- Homebrew ---
step "Homebrew"
if ! command -v brew &>/dev/null; then
	if confirm "Homebrew is not installed. Install it?"; then
		/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
		ok "Homebrew installed"
	else
		skip "Homebrew"
	fi
else
	ok "Homebrew already installed"
fi

if command -v brew &>/dev/null && confirm "Install packages from Brewfile?"; then
	brew bundle --file=brew/Brewfile
	ok "Brewfile packages installed"
else
	skip "Brewfile packages"
fi

# --- npm global packages ---
step "npm global packages"
if command -v npm &>/dev/null; then
	npm_pkgs=$(grep '^npm ' brew/Brewfile | sed 's/^npm "\(.*\)"/\1/' || true)
	if [[ -n "$npm_pkgs" ]]; then
		echo "  Packages: $npm_pkgs"
		if confirm "Install global npm packages?"; then
			echo "$npm_pkgs" | xargs -I{} npm install -g {}
			ok "npm packages installed"
		else
			skip "npm packages"
		fi
	else
		ok "No npm packages in Brewfile"
	fi
else
	skip "npm not available"
fi

# --- alerter ---
step "alerter (notification helper)"
if command -v alerter &>/dev/null; then
	ok "alerter already installed"
elif confirm "Install alerter?"; then
	curl -sL https://github.com/vjeantet/alerter/releases/latest/download/alerter -o /opt/homebrew/bin/alerter
	chmod +x /opt/homebrew/bin/alerter
	ok "alerter installed"
else
	skip "alerter"
fi

# --- znap (zsh plugin manager) ---
step "znap (zsh plugin manager)"
if [[ -d "$HOME/repos/znap" ]]; then
	ok "znap already installed"
elif confirm "Install znap?"; then
	git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git "$HOME/repos/znap"
	ok "znap installed"
else
	skip "znap"
fi

# --- Stow dotfiles ---
step "Stow dotfiles"
if confirm "Stow all packages into \$HOME?"; then
	mkdir -p "$HOME/.snowflake"
	for pkg in */; do
		stow --no-folding "$pkg"
	done
	ok "All packages stowed"
else
	skip "Stow"
fi

# --- Cleanup ---
step "Cleanup"
zwc_count=$(find "$DOTFILES_DIR" -name '*.zwc' | wc -l | tr -d ' ')
if [[ "$zwc_count" -gt 0 ]]; then
	find "$DOTFILES_DIR" -name '*.zwc' -delete
	ok "Removed $zwc_count stale .zwc files"
else
	ok "No stale .zwc files"
fi

# --- Git hooks ---
step "Git hooks"
git config core.hooksPath .githooks
ok "Hooks path set to .githooks"

# --- .env ---
step "Environment file"
if [[ -f "$DOTFILES_DIR/.env" ]]; then
	ok ".env already exists"
elif confirm "Create .env from example.env?"; then
	cp "$DOTFILES_DIR/example.env" "$DOTFILES_DIR/.env"
	ok ".env created — fill in your values"
else
	skip ".env"
fi

echo -e "\n${GREEN}Done!${RESET}"
