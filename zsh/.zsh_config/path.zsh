# System PATH Configuration
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Rust / Cargo (adds $HOME/.cargo/bin to PATH)
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
