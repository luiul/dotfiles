# Kubernetes
alias k=kubectl

# Listing (eza)
alias ls="eza --group-directories-first --git"
alias la="eza -lah --group-directories-first --git --time-style=relative --sort=modified --reverse"
alias lt="eza --tree --level=2 --group-directories-first --git-ignore"

# Clipboard
alias copy='pbcopy'
alias copywd='printf %s "$PWD" | pbcopy'
alias copydirs='print -rn -- ${(F)$(print -l -- *(/N:t))} | pbcopy'

# File Management
alias rmf='rm -i'  # Interactive file removal
alias rmd='rm -ri' # Interactive directory removal

# Homebrew Services for Borders
alias borders-restart='brew services restart borders'
