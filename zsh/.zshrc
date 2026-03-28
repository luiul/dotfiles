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

# Start or attach to ssh-agent (function lives in ~/.zsh_config/funcs.zsh)
if typeset -f ssh_agent_start >/dev/null 2>&1; then
	ssh_agent_start
fi

# Source Znap (installed via setup.sh)
if [[ ! -r ~/repos/znap/znap.zsh ]]; then
	echo "znap not found. Run setup.sh to install." >&2
	return 1
fi
source ~/repos/znap/znap.zsh

# Install plugins
znap source marlonrichert/zsh-autocomplete

znap eval uv  'uv generate-shell-completion zsh'
znap eval uvx 'uvx --generate-shell-completion zsh'

# Run the following command at the end of the shell config file
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Set up fzf key bindings and fuzzy completion
znap eval fzf 'fzf --zsh'

# zstyle ':completion:*' list-prompt ''
# zstyle ':completion:*' select-prompt ''

if command -v wt >/dev/null 2>&1; then znap eval wt 'command wt config shell init zsh'; fi

# zoxide must be the last thing initialized
znap eval zoxide 'zoxide init --cmd cd zsh'
