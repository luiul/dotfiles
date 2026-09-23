# Kubernetes
alias k=kubectl

# Listing (eza)
# NOTE: eza 0.23 needs =always here, =auto decorates nothing even on a tty
alias ls="eza --group-directories-first --git --icons=always --classify=always"
alias ll="eza -lh --group-directories-first --git --icons=always --classify=always"
alias lt="eza --tree --level=2 --group-directories-first --git-ignore --icons=always --classify=always"

# Long listing, newest last, recursive dir sizes, plus a grand total (du walks the tree)
unalias la 2>/dev/null
la() {
  eza -lah --total-size --group-directories-first --git --icons=always --classify=always --time-style=relative --sort=modified --reverse "$@" || return
  local target=.
  if [[ $# -gt 0 ]]; then
    [[ -d ${@[-1]} ]] || return
    target=${@[-1]}
  fi
  print -r -- "total: $(command du -sh "$target" 2>/dev/null | cut -f1)"
}

# Clipboard
alias copy='pbcopy'
alias copywd='printf %s "$PWD" | pbcopy'
alias copydirs='print -rn -- ${(F)$(print -l -- *(/N:t))} | pbcopy'

# File Management
alias rmf='rm -i'  # Interactive file removal
alias rmd='rm -ri' # Interactive directory removal

# Homebrew Services for Borders
alias borders-restart='brew services restart borders'

# Coppice (path-based CLI for git worktrees, wraps wt)
alias cop=coppice
