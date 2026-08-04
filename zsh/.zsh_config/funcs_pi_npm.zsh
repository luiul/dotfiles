# `npm audit fix` for pi's own npm project.
#
# `pi update --extensions` manages packages (pi-mcp-adapter, context-mode,
# pi-hermes-memory, etc.) in a private npm project at ~/.pi/agent/npm --
# it has its own package.json/package-lock.json, separate from both the
# system global npm prefix (`npm -g`, which `npm audit` explicitly refuses
# to test -- EAUDITGLOBAL) and whatever directory you happen to be in.
#
# Running `npm audit fix` from a random cwd after `pi update --extensions`
# fails with ENOLOCK (no lockfile there) unless that cwd happens to be an
# unrelated npm project of its own. These functions target the right
# directory regardless of cwd.

typeset -g PI_NPM_DIR="${PI_NPM_DIR:-$HOME/.pi/agent/npm}"

_pi_npm_dir_check() {
	if [[ ! -f "$PI_NPM_DIR/package-lock.json" ]]; then
		print -P "%F{red}✗%f $PI_NPM_DIR/package-lock.json not found. Run: pi update --extensions"
		return 1
	fi
	return 0
}

# Show the audit report for pi's extensions, without fixing anything.
# Usage: pi-extensions-audit
pi-extensions-audit() {
	emulate -L zsh
	_pi_npm_dir_check || return 1
	(cd "$PI_NPM_DIR" && npm audit)
}

# Fix vulnerabilities in pi's extensions dependency tree.
# Usage: pi-extensions-audit-fix [--force]
pi-extensions-audit-fix() {
	emulate -L zsh
	_pi_npm_dir_check || return 1
	print -P "%F{blue}==>%f npm audit fix in $PI_NPM_DIR"
	(cd "$PI_NPM_DIR" && npm audit fix "$@")
}

# Update pi's extensions, then immediately audit-fix the result -- the
# single command for the `pi update --extensions` -> vulnerabilities ->
# fix loop that previously required knowing to cd into ~/.pi/agent/npm.
# Usage: pi-extensions-upgrade
pi-extensions-upgrade() {
	emulate -L zsh
	command -v pi &>/dev/null || { print -P "%F{red}✗%f pi not found"; return 1 }
	pi update --extensions
	pi-extensions-audit-fix
}
