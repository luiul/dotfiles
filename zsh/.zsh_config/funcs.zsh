cht() {
	local query=$(echo "$@" | tr ' ' '+')
	curl cht.sh/$query
}

md-to-rtf() {
	# Check if the input file is provided
	if [ -z "$1" ]; then
		echo "Please provide the path to the markdown file."
		return 1
	fi

	# Get the full path of the markdown file
	local md_file="$1"

	# Extract the directory and filename without extension
	local dir=$(dirname "$md_file")
	local filename=$(basename "$md_file" .md)

	# Define the output RTF file path
	local rtf_file="${dir}/${filename}.rtf"

	# Check if the RTF file already exists and notify user
	if [ -f "$rtf_file" ]; then
		echo "RTF file ${rtf_file} already exists. It will be replaced."
	fi

	# Convert the markdown file to RTF using pandoc (overwrites if exists)
	pandoc -f markdown -s "$md_file" -o "$rtf_file"

	# Check if the conversion was successful
	if [ $? -ne 0 ]; then
		echo "Failed to convert markdown to RTF."
		return 1
	fi

	# Copy the contents of the RTF file to the clipboard
	cat "$rtf_file" | pbcopy

	# Confirm the action
	echo "RTF file created at ${rtf_file} and copied to clipboard."
}

upgrade-tools() {
	local GREEN='\033[0;32m' YELLOW='\033[0;33m' RED='\033[0;31m' BLUE='\033[0;34m' RESET='\033[0m'
	_upgrade_step() { echo -e "\n${BLUE}==>${RESET} $1"; }
	_upgrade_ok() { echo -e "  ${GREEN}✓${RESET} $1"; }
	_upgrade_skip() { echo -e "  ${YELLOW}⊘${RESET} $1 (skipped)"; }
	_upgrade_fail() { echo -e "  ${RED}✗${RESET} $1"; }
	_upgrade_cleanup() { unfunction _upgrade_step _upgrade_ok _upgrade_skip _upgrade_fail _upgrade_cleanup _upgrade_interrupt 2>/dev/null; trap - INT; }
	_upgrade_interrupt() { echo -e "\n  ${YELLOW}⚠${RESET} interrupted"; _upgrade_cleanup; return 130; }
	trap _upgrade_interrupt INT

	_upgrade_step "Homebrew"
	if command -v brew &>/dev/null; then
		if brew update && brew upgrade && brew cleanup; then
			_upgrade_ok "Homebrew up to date"
		else
			_upgrade_fail "Homebrew failed (exit $?)"
		fi
	else
		_upgrade_skip "brew not installed"
	fi

	_upgrade_step "uv tools"
	if command -v uv &>/dev/null; then
		if uv tool upgrade --all; then
			_upgrade_ok "uv tools up to date"
		else
			_upgrade_fail "uv tools failed (exit $?)"
		fi
	else
		_upgrade_skip "uv not installed"
	fi

	_upgrade_step "npm global packages"
	if command -v npm &>/dev/null; then
		if npm update -g; then
			_upgrade_ok "npm globals up to date"
		else
			_upgrade_fail "npm update failed (exit $?)"
		fi
	else
		_upgrade_skip "npm not installed"
	fi

	_upgrade_step "Claude Code"
	if command -v claude &>/dev/null; then
		if claude update; then
			_upgrade_ok "Claude Code up to date"
		else
			_upgrade_fail "Claude Code update failed (exit $?)"
		fi
	else
		_upgrade_skip "claude not installed"
	fi

	_upgrade_step "Claude plugins"
	if command -v claude &>/dev/null && command -v jq &>/dev/null; then
		local plugins
		if ! claude plugin marketplace update; then
			_upgrade_fail "marketplace refresh failed (exit $?)"
		fi
		plugins=$(claude plugin list --json 2>/dev/null | jq -r '.[].id' 2>/dev/null)
		if [[ -n "$plugins" ]]; then
			local failed=0 plugin
			while IFS= read -r plugin; do
				[[ -z "$plugin" ]] && continue
				claude plugin update "$plugin" || failed=1
			done <<<"$plugins"
			if (( failed == 0 )); then
				_upgrade_ok "Claude plugins up to date"
			else
				_upgrade_fail "one or more plugin updates failed"
			fi
		else
			_upgrade_skip "no plugins installed"
		fi
	else
		_upgrade_skip "claude or jq not installed"
	fi

	_upgrade_step "Claude skills"
	if command -v npx &>/dev/null; then
		if npx --yes skills@latest update -g -y; then
			_upgrade_ok "Claude skills up to date"
		else
			_upgrade_fail "skills update failed (exit $?)"
		fi
	else
		_upgrade_skip "npx not installed"
	fi

	_upgrade_cleanup
}

cod() {
	cd "$@" 2> >(grep -v "already in the only match" >&2) && code .
}

# Start or reuse ssh-agent (once per reboot)
ssh_agent_init() {
	local agent_env_file="$HOME/.ssh/agent_env"

	if [[ -f "$agent_env_file" ]]; then
		source "$agent_env_file" >/dev/null 2>&1

		if ! ssh-add -l >/dev/null 2>&1; then
			rm -f "$agent_env_file"
			unset SSH_AUTH_SOCK SSH_AGENT_PID
		fi
	fi

	if [[ -z "$SSH_AUTH_SOCK" ]]; then
		eval "$(ssh-agent -s)" >/dev/null

		local key_file
		for key_file in "$HOME"/.ssh/id_{ed25519,ecdsa,rsa}; do
			[[ -f "$key_file" ]] && ssh-add "$key_file" </dev/null && break
		done

		{
			echo "export SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
			echo "export SSH_AGENT_PID=$SSH_AGENT_PID"
		} >|"$agent_env_file"
	fi
}
