# Basic Repository Information
alias ghash="git rev-parse --short HEAD"      # Get the short hash of the current commit
alias gst="git status -sb"                    # Show short, branch-based status
alias gclone="git clone --recurse-submodules" # Clone a repository with submodules

# Branch Management
alias gco="git checkout"       # Checkout a branch
alias gbranch="git branch -av" # List all branches, local and remote

# Staging and Committing Changes
alias gadd="git add --all"    # Stage all changes for commit
alias gcommit="git commit -m" # Commit with a message
alias gac="gadd && gcommit"   # Add all changes and commit, usage: gac 'Your commit message'

# Remote Interaction
alias gpush='git push origin "$(git symbolic-ref --short HEAD)"' # Push the current branch
alias gfetch="git fetch --prune"                                 # Fetch and prune remote branches
alias gfetchall="git fetch --all --prune"                        # Fetch all remotes and prune deleted branches
alias gpull="gfetch && git pull --recurse-submodules"            # Pull changes from the remote
alias gpullrebase="git pull --rebase"                            # Pull with rebase
alias gurl="git remote show origin | grep URL"
alias goriginmaster='git fetch origin && git reset --hard origin/master && git clean -fd'

# Switching Branches
alias gs="git switch" # Switch branches, usage: gswitch branchName

# Stash Management
alias gstash="git stash push -m" # Stash changes with a message
alias glist="git stash list"     # List all stashes

# Commit History and Changes
alias glastcommit="git show --stat"   # Show the last commit
alias gundo="git reset --soft HEAD~1" # Undo last commit, keep changes staged

# # Diff Viewing
# alias gdiff="git diff"                # Show unstaged differences
# alias gdiffstaged="git diff --staged" # Show differences in staged files

# # Tag Management
# alias gtag="git tag"             # List all tags
# alias gtagnew="git tag -a"       # Create a new annotated tag, usage: gtagnew v1.0 -m 'Version 1.0'
# alias gtagsync="git push --tags" # Push tags to remote

# Log Filtering
alias glog="git log --oneline --decorate" # Basic log
# alias glogp="git log --patch"             # Show patches (detailed diffs) with log

# # Cherry-picking
# alias gcherry="git cherry-pick" # Usage: gcherry commitSHA1

# # Rebasing
# alias grebase="git rebase"     # Start a rebase
# alias grebasei="git rebase -i" # Start an interactive rebase

# Hard Resets
# alias greset="git reset --hard" # Usage: greset HEAD to discard all working directory changes

# Handling Large Repositories with Submodules

# Initialize and update submodules
alias gsubupdateinit="git submodule update --init --recursive"
# This command initializes any uninitialized submodules and updates them to the commits specified in the superproject:
# - `--init`: Initialize submodules that have not been started yet, effectively cloning submodule repositories into the superproject.
# - `--recursive`: Apply the submodule update operation not only to the submodules but also to any nested submodules inside them.

# Update all submodules to the latest commit on their respective tracked branches
alias gsubupdate="git submodule update --recursive --remote"
# This command updates each submodule to the latest commit available on the branch specified in their `.gitmodules` or `.git/config`:
# - `--recursive`: Ensures that the update applies not only to the direct submodules but also to any nested submodules within them.
# - `--remote`: Instead of updating the submodules to the commit stored in the superproject, this option updates them to the latest commit on their respective remote branches. This is useful for keeping submodules aligned with ongoing development without manually checking out newer commits.

# alias gsubstatus="git submodule foreach 'echo $path $(git status -s)'"
alias gsubstatus='git submodule foreach --quiet '\''if [ -d .git ]; then echo "$path $(git status -s)"; else echo "$path is not initialized"; fi'\'''
# This command iterates over each submodule and prints its path and the output of `git status -s`, showing any changes or new files.

alias gsubsync="git submodule sync --recursive"
# This command synchronizes the URLs of the submodules to match the URLs specified in the `.gitmodules` file, recursively through all submodules.

alias gsubpull="git submodule update --recursive --remote --merge"
# This command fetches and merges the latest changes for all submodules from their respective branches specified in `.gitmodules`.

alias gsubcommit='git submodule foreach "git add . && git commit -m \"Updated submodule\" && git push"'
# This runs `git add`, `git commit`, and `git push` in each submodule, committing and pushing changes. Remember to check submodule status first.

# Setup and Configuration
alias add-git-ignore="cp ~/.gitignore ."
