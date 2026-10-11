# Skip /etc/zprofile and /etc/zshrc.
# Why: each spawns a process (path_helper, locale) and every process spawn on this
# machine is taxed ~250ms by SentinelOne. Skipping both saves ~0.5s per new shell.
# The path array below replaces what path_helper builds from /etc/paths and
# /etc/paths.d, so nothing is lost. If IT adds a new /etc/paths.d entry, add it here.
# Revert: delete this line and the path array (leave the cargo line).
unsetopt GLOBAL_RCS

# Rust / Cargo first, so ~/.cargo/bin ends up near the end of PATH. That matches the
# old order, where /etc/zprofile (path_helper) prepended the system paths after it.
. "$HOME/.cargo/env"

# path_helper replacement: system entries from /etc/paths + /etc/paths.d (2026-10).
# Inherited PATH entries stay appended at the end, duplicates removed (typeset -U).
typeset -U path PATH
path=(
  /opt/homebrew/bin
  /opt/homebrew/sbin
  /usr/local/bin
  /System/Cryptexes/App/usr/bin
  /usr/bin
  /bin
  /usr/sbin
  /sbin
  /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin
  /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin
  /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin
  /pkg/env/global/bin
  /opt/podman/bin
  $path
)
