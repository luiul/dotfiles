# Source all Zsh configuration files from .zsh_config
for file in ~/.zsh_config/*.zsh; do
  # printf "Loading: %s\n" "$file"
  source "$file"
  if [[ $? -eq 0 ]]; then
    printf "Loaded: %s\n" "$file"
  else
    printf "Error loading: %s\n" "$file"
  fi
done

# Download Znap, if it's not there yet.
[[ -r ~/Repos/znap/znap.zsh ]] ||
  git clone --depth 1 -- \
    https://github.com/marlonrichert/zsh-snap.git ~/Repos/znap
source ~/Repos/znap/znap.zsh # Start Znap

# Install plugins
znap source marlonrichert/zsh-autocomplete

# Load plugins
eval "$(gh copilot alias -- zsh)"
eval "$(fzf --zsh)"
eval "$(zoxide init --cmd cd zsh)"

. "$HOME/.cargo/env"

. "$HOME/.local/share/../bin/env"
eval "$(uv generate-shell-completion zsh)"
eval "$(uvx --generate-shell-completion zsh)"

fpath+=~/.zfunc
autoload -Uz compinit && compinit

zstyle ':completion:*' list-prompt ''
zstyle ':completion:*' select-prompt ''

# Run the following command at the end of the shell config file
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
