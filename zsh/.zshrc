# ⚙️ Loading Zsh configuration files from ~/.zsh_config
echo "📦 Loading Zsh configuration files..."

zsh_config_dir="$HOME/.zsh_config"

# Check if the directory exists
if [[ ! -d "$zsh_config_dir" ]]; then
  echo "❌ Config directory not found: $zsh_config_dir"
  return 1
fi

# Enable nullglob so the for-loop doesn't run if no .zsh files exist
setopt nullglob

zsh_files=("$zsh_config_dir"/*.zsh)

# Check if any files were found
if [[ ${#zsh_files[@]} -eq 0 ]]; then
  echo "❗ No .zsh files found in $zsh_config_dir"
else
  for file in "${zsh_files[@]}"; do
    # Source the file
    source "$file"

    # Check if the file was loaded successfully
    if [[ $? -ne 0 ]]; then
      printf "❌ Error loading: %s\n" "$file"
    fi
  done
fi

echo "✅ Zsh configuration files loaded."

# Start or attach to ssh-agent (function lives in ~/.zsh_config/funcs.zsh)
if typeset -f ssh_agent_start >/dev/null 2>&1; then
  ssh_agent_start
fi

# Download Znap, if it's not there yet.
[[ -r ~/repos/znap/znap.zsh ]] ||
  git clone --depth 1 -- \
    https://github.com/marlonrichert/zsh-snap.git ~/repos/znap
source ~/repos/znap/znap.zsh # Start Znap

# Install plugins
znap source marlonrichert/zsh-autocomplete

eval "$(uv generate-shell-completion zsh)"
eval "$(uvx --generate-shell-completion zsh)"

# Automatically activate virtualenvs
activate

# Run the following command at the end of the shell config file
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Set up fzf key bindings and fuzzy completion
source <(fzf --zsh)
eval "$(zoxide init --cmd cd zsh)"

# zstyle ':completion:*' list-prompt ''
# zstyle ':completion:*' select-prompt ''
