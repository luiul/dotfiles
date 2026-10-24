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
if ! command -v stow &>/dev/null; then
	skip "stow not installed"
elif confirm "Stow all packages into \$HOME?"; then
	# snowflake package uses --no-folding so runtime files (logs, cache) stay
	# outside the repo — target dir must exist before stow creates per-file links
	mkdir -p "$HOME/.snowflake"
	# aws: --no-folding symlinks only ~/.aws/config; target dir must exist first
	mkdir -p "$HOME/.aws"
	# sublime: User dir only exists after first launch, but --no-folding needs it
	mkdir -p "$HOME/Library/Application Support/Sublime Text/Packages/User"
	# rectangle, karabiner, datagrip and snapzy are export-only (not stowed);
	# docs and scripts are not packages.
	for pkg in */; do
		case "${pkg%/}" in
			rectangle | karabiner | datagrip | snapzy | docs | scripts) continue ;;
		esac
		stow --no-folding "${pkg%/}"
	done
	ok "All packages stowed"
else
	skip "Stow"
fi

# --- Shared agent scratch dir ---
step "Agent scratch dir"
# pi and Claude write review/proofread output to ~/scratch (canonical AGENTS.md)
mkdir -p "$HOME/scratch"
ok "~/scratch ready"

# --- SSH key ---
step "SSH key"
if [[ -f "$HOME/.ssh/id_ed25519" ]]; then
	ok "SSH key already exists"
else
	if confirm "Generate a new ed25519 SSH key?"; then
		read -rp "  Email/comment for the key: " ssh_email
		ssh-keygen -t ed25519 -C "$ssh_email" -f "$HOME/.ssh/id_ed25519"
		ok "SSH key generated"
	else
		skip "SSH keygen"
	fi
fi

if [[ -f "$HOME/.ssh/id_ed25519" ]] && confirm "Add SSH key to agent + Apple Keychain?"; then
	ssh-add --apple-use-keychain "$HOME/.ssh/id_ed25519"
	ok "SSH key added to Keychain"
	echo "  Public key (add to GitHub at https://github.com/settings/keys):"
	echo ""
	cat "$HOME/.ssh/id_ed25519.pub" | sed 's/^/    /'
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

# --- Git filters ---
step "Git filters"
git config filter.strip-sublime-fontsize.clean "sed '/^[[:space:]]*\"font_size\"/d'"
ok "Sublime font_size strip filter configured"
git config filter.strip-pi-thinkinglevel.clean "jq 'del(.defaultThinkingLevel)'"
git config filter.strip-pi-thinkinglevel.smudge cat
git config filter.strip-pi-thinkinglevel.required true
ok "pi defaultThinkingLevel strip filter configured"

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
