# System PATH Configuration
# NOTE: the base system paths (what path_helper used to add from /etc/paths and
# /etc/paths.d) are set in ~/.zshenv, which unsets GLOBAL_RCS to skip the ~250ms
# SentinelOne-taxed path_helper spawn. Keep the two files in sync.
# pi lives at ~/.pi/agent/bin since the 1.4.0 self-managed install (pi update
# replaced the old /opt/homebrew/lib/node_modules package and its bin shim).
export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Rust / Cargo (adds $HOME/.cargo/bin to PATH)
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
