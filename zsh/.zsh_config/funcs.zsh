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
	# TRAPINT returning 0 swallows Ctrl+C so only the current step dies and
	# the next step runs. Use Ctrl+\ (SIGQUIT) to abort the whole function.
	TRAPINT() { return 0; }

	_report() {
		case $2 in
		0) print -P "  %F{green}✓%f $1 up to date" ;;
		130) print -P "  %F{yellow}⚠%f $1 interrupted" ;;
		*) print -P "  %F{red}✗%f $1 failed (exit $2)" ;;
		esac
	}
	_run() {
		local label=$1 tool=$2
		shift 2
		print -P "\n%F{blue}==>%f $label"
		if ! command -v "$tool" &>/dev/null; then
			print -P "  %F{yellow}⊘%f $tool not installed (skipped)"
			return
		fi
		"$@"
		_report "$label" $?
	}
	_preview() {
		local label=$1 tool=$2
		shift 2
		print -P "\n%F{blue}==>%f $label"
		if ! command -v "$tool" &>/dev/null; then
			print -P "  %F{yellow}⊘%f $tool not installed"
			return
		fi
		if (($# == 0)); then
			print -P "  %F{yellow}⊘%f no preview available"
			return
		fi
		local out
		out=$("$@" 2>/dev/null)
		[[ -n "$out" ]] && print "$out" | sed 's/^/  /' || print -P "  %F{green}✓%f up to date"
	}

	if [[ $1 == --check || $1 == -c ]]; then
		command -v brew &>/dev/null && brew update >/dev/null 2>&1
		_preview "Homebrew"            brew   brew outdated
		_preview "uv tools"            uv
		_preview "npm global packages" npm    npm outdated -g
		_preview "Claude Code"         claude
		_preview "Claude plugins"      claude
		_preview "Claude skills"       npx
		unfunction _run _report _preview TRAPINT
		return
	fi

	_run "Homebrew" brew sh -c 'brew update && brew upgrade && brew cleanup'
	_run "uv tools" uv uv tool upgrade --all
	_run "npm global packages" npm npm update -g
	_run "Claude Code" claude claude update

	print -P "\n%F{blue}==>%f Claude plugins"
	if ! command -v claude &>/dev/null || ! command -v jq &>/dev/null; then
		print -P "  %F{yellow}⊘%f claude or jq not installed (skipped)"
	else
		claude plugin marketplace update
		_report "marketplace refresh" $?
		local plugins plugin
		plugins=$(claude plugin list --json 2>/dev/null | jq -r '.[].id' 2>/dev/null)
		if [[ -z "$plugins" ]]; then
			print -P "  %F{yellow}⊘%f no plugins installed (skipped)"
		else
			while IFS= read -r plugin; do
				[[ -n "$plugin" ]] && {
					claude plugin update "$plugin"
					_report "$plugin" $?
				}
			done <<<"$plugins"
		fi
	fi

	_run "Claude skills" npx npx --yes skills@latest update -g -y

	unfunction _run _report _preview TRAPINT
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
