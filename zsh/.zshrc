zsh_config_dir="$HOME/.zsh_config"

if [[ ! -d "$zsh_config_dir" ]]; then
	echo "Config directory not found: $zsh_config_dir" >&2
	return 1
fi

setopt nullglob

zsh_files=("$zsh_config_dir"/*.zsh)

if [[ ${#zsh_files[@]} -eq 0 ]]; then
	echo "No .zsh files found in $zsh_config_dir" >&2
else
	for file in "${zsh_files[@]}"; do
		source "$file" || printf "Error loading: %s\n" "$file" >&2
	done
fi

# Start ssh-agent (function lives in ~/.zsh_config/funcs.zsh)
if typeset -f ssh_agent_init >/dev/null 2>&1; then
	ssh_agent_init
fi

# Load environment variables from ~/.env (not tracked in git)
if [[ -f ~/.env ]]; then
	set -a
	source ~/.env
	set +a
else
	echo "Warning: ~/.env not found. Copy dotfiles/example.env to ~/.env and fill in your values." >&2
fi

# Source Znap (installed via setup.sh)
if [[ ! -r ~/repos/znap/znap.zsh ]]; then
	echo "znap not found. Run setup.sh to install." >&2
	return 1
fi
source ~/repos/znap/znap.zsh

# Limit autocomplete menu height to prevent it from taking over the terminal
zstyle ':autocomplete:*' list-lines 16

# Install plugins
znap source marlonrichert/zsh-autocomplete

znap eval uv  'uv generate-shell-completion zsh'
znap eval uvx 'uvx --generate-shell-completion zsh'

# Run the following command at the end of the shell config file
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Set up fzf key bindings and fuzzy completion
znap eval fzf 'fzf --zsh'

if command -v wt >/dev/null 2>&1; then znap eval wt 'command wt config shell init zsh'; fi

# zoxide must be the last thing initialized
znap eval zoxide 'zoxide init --cmd cd zsh'
