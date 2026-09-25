# Kubernetes
alias k=kubectl

# Listing (eza)
# NOTE: eza 0.23 needs =always here, =auto decorates nothing even on a tty
alias ls="eza --group-directories-first --git --icons=always --classify=always"
alias ll="eza -lh --group-directories-first --git --icons=always --classify=always"
alias lt="eza --tree --level=2 --group-directories-first --git-ignore --icons=always --classify=always"

# Long listing, all files, newest last. No size walks (eza --total-size,
# du -sh) here; sizes get their own commands.
unalias la 2>/dev/null
alias la="eza -lah --group-directories-first --git --icons=always --classify=always --time-style=relative --sort=modified --reverse"

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
