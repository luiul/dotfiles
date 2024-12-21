# System PATH Configuration
export PATH="/Users/luisaceituno/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Kubernetes Configuration
export KUBECONFIG="/Users/luisaceituno/.kube/config:/Users/luisaceituno/.kube/eksconfig"

# Python and Editor Settings
# export UV_PYTHON="python3.9"
export EDITOR="code"

# Development Environment Variables
export ENVIRONMENT="dev"

# DBT Configuration
export ENV="staging"
export DBT_PROFILES_DIR="/Users/luisaceituno/.dbt"

# # GitHub Token Configuration
# if [[ -s ~/.github-tokens ]]; then
#   export GITHUB_TOKEN_TARDIS=$(grep '^tardis' ~/.github-tokens | cut -d '=' -f 2 | tr -d ' ')
#   if [[ -z "$GITHUB_TOKEN" ]]; then
#     export GITHUB_TOKEN=$(head -n 1 ~/.github-tokens | cut -d '=' -f 2 | tr -d ' ')
#   fi
# else
#   echo ".github-tokens file does not exist or is empty."
# fi

# S3 Configuration
export S3_HOME="s3://hf-bi-dwh-uploader/luisaceituno/"

# Vault Configuration
export VAULT_ADDR="https://vault.secrets.hellofresh.io"

if [[ -s ~/.vault-token ]]; then
  export VAULT_TOKEN=$(<~/.vault-token)
else
  echo "Vault token file does not exist or is empty."
fi

# Databricks Configuration
if [[ -s ~/.databrickscfg ]]; then
  export DATABRICKS_HOST=$(grep '^host' ~/.databrickscfg | cut -d = -f 2 | tr -d ' ')
  export DATABRICKS_TOKEN=$(grep '^token' ~/.databrickscfg | cut -d = -f 2 | tr -d ' ')
else
  echo ".databrickscfg file does not exist or is empty."
fi

if [[ -s ~/.databricks-http ]]; then
  export DATABRICKS_PATH=$(<~/.databricks-http)
else
  echo "Databricks HTTP file does not exist or is empty."
fi

if [[ -s ~/.databrickscfg-opsdap ]]; then
  export DATABRICKS_OPSDAP_HOST=$(grep '^host' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
  export DATABRICKS_OPSDAP_TOKEN=$(grep '^token' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
  export DATABRICKS_OPSDAP_PATH=$(grep '^http_path' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
else
  echo ".databrickscfg-opsdap file does not exist or is empty."
fi

# Pipx Configuration
export PATH="$PATH:/Users/luisaceituno/.local/bin"

# sqlfmt
export SQLFMT_LINE_LENGTH=120

# Environment Variables
alias dev='ENV=dev'
alias staging='ENV=staging'
alias live='ENV=live'

alias k=kubectl

# Basic Commands
alias ls="ls --color=auto"
alias la="ls -AthGl"
alias lg="la | grep -i --color" # List all files and filter them using grep="ls -lA | grep"  # List all files and filter them using grep
alias copy='pbcopy'

# File Management
alias rmf='rm -i'  # Interactive file removal
alias rmd='rm -ri' # Interactive directory removal

# AWS CLI
alias s3="aws s3" # Shortcut for AWS S3 command

# alias act_prod="activate && export ENVIRONMENT=production" # Activate virtual environment and set ENVIRONMENT
# alias act_stg="activate && export ENVIRONMENT=staging"     # Activate virtual environment and set ENVIRONMENT

alias pip-upgrade-all="pip freeze --local | grep -v '^\-e' | cut -d = -f 1  | xargs -n1 pip install -U" # Upgrade all pip packages
alias pip-uninstall-all="pip uninstall -y -r <(pip freeze)"
# alias pip-install-reqs="find . -name 'requirements.txt' -exec pip install -r {} \;"

# Basic Repository Information
alias ghash="git rev-parse --short HEAD"      # Get the short hash of the current commit
alias gst="git status -sb"                    # Show short, branch-based status
alias gclone="git clone --recurse-submodules" # Clone a repository with submodules

# Branch Management
alias gco="git checkout"       # Checkout a branch
alias gbranch="git branch -av" # List all branches, local and remote
# alias gdeletemerged='git branch --merged | egrep -v "(^\*|master|main)" | xargs -I {} sh -c '\''echo Deleting branch: {}; read -p "Are you sure? (y/n): " ans; if [ "$ans" = "y" ]; then git branch -d {}; fi'\'

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

alias gsubstatus="git submodule foreach 'echo $path $(git status -s)'"
# This command iterates over each submodule and prints its path and the output of `git status -s`, showing any changes or new files.

alias gsubsync="git submodule sync --recursive"
# This command synchronizes the URLs of the submodules to match the URLs specified in the `.gitmodules` file, recursively through all submodules.

alias gsubpull="git submodule update --recursive --remote --merge"
# This command fetches and merges the latest changes for all submodules from their respective branches specified in `.gitmodules`.

alias gsubcommit='git submodule foreach "git add . && git commit -m \"Updated submodule\" && git push"'
# This runs `git add`, `git commit`, and `git push` in each submodule, committing and pushing changes. Remember to check submodule status first.

# Setup and Configuration
alias add-git-ignore="cp ~/.gitignore ."

# Virtual Environment Management
# alias activate='activate_python_venv' # Activate the virtual environment

# Misc
alias copydirs="ls -d */ | tr -d '/' | pbcopy"
alias countfiles="ls -1 | wc -l"
alias copywd="pwd | pbcopy"

# aws_sso() {
#   MY_AWS_PROFILE="$1"

#   yawsso --profile "$MY_AWS_PROFILE"
#   if [ $? -eq 0 ]; then
#     echo "still valid SSO credentials for $MY_AWS_PROFILE"
#   else
#     aws sso login --profile "$MY_AWS_PROFILE"
#     yawsso --profile "$MY_AWS_PROFILE"
#   fi
#   awsume "$MY_AWS_PROFILE"
#   export AWS_PROFILE="$MY_AWS_PROFILE"
# }

alias aws-sso-it="aws_sso sso-hf-it-developer"

find_duplicate_filenames() {
  # Help message
  if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "Usage: find_duplicate_filenames [root_directory] [prefix]"
    echo ""
    echo "Find files with the same name recursively in all directories."
    echo ""
    echo "Arguments:"
    echo "  root_directory   The root directory to start searching from. Defaults to the current directory."
    echo "  prefix           (Optional) Search only in directories starting with this prefix. If not provided, searches all directories."
    echo ""
    echo "Examples:"
    echo "  find_duplicate_filenames           # Search all directories from the current directory"
    echo "  find_duplicate_filenames /path/to  # Search all directories from /path/to"
    echo "  find_duplicate_filenames /path/to ops-dap # Search in directories starting with 'ops-dap'"
    return
  fi

  local root_dir=${1:-.} # Default to current directory if no root directory is provided
  local prefix=${2:-}    # No default prefix, will search all directories if not provided

  if [[ -n "$prefix" ]]; then
    # If a prefix is provided, search only in directories starting with the prefix
    find "$root_dir" -type d -name "${prefix}*" -exec find {} -type f \;
  else
    # If no prefix, search all directories
    find "$root_dir" -type f
  fi | awk -F/ '{print $NF}' | sort | uniq -d
}

gignorelocal() {
  git status >/dev/null 2>&1
  if [ $? -eq 0 ]; then
    mkdir -p $(git rev-parse --show-toplevel)/.git/info
    ${EDITOR:-vi} $(git rev-parse --show-toplevel)/.git/info/exclude
  else
    echo "Not a git project."
  fi
}

gignoreglobal() {
  # Check if Git is installed
  git --version >/dev/null 2>&1
  if [ $? -eq 0 ]; then
    # Check if the global gitignore file is set
    git config --global core.excludesfile >/dev/null 2>&1
    if [ $? -ne 0 ]; then
      # If not set, set the default global gitignore path to ~/.gitignore_global
      git config --global core.excludesfile ~/.gitignore_global
      echo "Global gitignore file set to ~/.gitignore_global"
    fi
    # Create or open the global gitignore file with the default editor
    ${EDITOR:-vi} $(git config --global core.excludesfile)
  else
    echo "Git is not installed or not available."
  fi
}

gdeletemerged() {
  # Read all eligible branches into an array
  local branches=($(git branch --merged | egrep -v "(^\*|master|main)"))

  # Iterate over the array
  for branch in "${branches[@]}"; do
    echo "Deleting branch: $branch"
    echo "Do you want to delete this branch? (y/n)"
    read ans
    if [[ "$ans" == "y" ]]; then
      git branch -d "$branch"
    fi
  done
}

gstore() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: git_restore_file <commit> <file-path>"
    return 1
  fi

  local commit=$1
  local file_path=$2

  git restore --source="$commit" --staged --worktree "$file_path"
}

# Recursively activate a virtual environment
activate() {
  current_dir=$(pwd)
  home_dir="$HOME"

  while [ "$current_dir" != "$home_dir" ]; do
    echo "Checking in: $current_dir"
    if [ -d "$current_dir/.venv" ]; then
      source "$current_dir/.venv/bin/activate"
      echo "Activated .venv in $current_dir"
      return
    elif [ -d "$current_dir/venv" ]; then
      source "$current_dir/venv/bin/activate"
      echo "Activated venv in $current_dir"
      return
    fi
    # Move to the parent directory
    current_dir=$(dirname "$current_dir")
  done

  echo "No virtual environment found up to $home_dir."
}

remove_pycache() {
  # Create a temporary file to hold the list of items to be deleted
  local tempfile=$(mktemp)

  # Find and log directories and files, then delete them
  find . \( -type d -name "__pycache__" -o -type f -name "*.pyc" \) -print | tee "$tempfile" | xargs rm -rf

  # Summarize the results
  local dir_count=$(grep -c '/__pycache__$' "$tempfile")
  local file_count=$(grep -c '\.pyc$' "$tempfile")

  echo "Removed __pycache__ directories: $dir_count"
  echo "Removed .pyc files: $file_count"
  echo "Details of removed items were logged to: $tempfile"

  # Display the contents of the log file (optional)
  echo "Do you want to review the deleted items log? (y/n)"
  read answer
  if [[ "$answer" == "y" ]]; then
    cat "$tempfile"
  fi

  # Cleanup: remove the log file
  echo "Cleaning up log file..."
  rm "$tempfile"
  echo "Log file removed and cleanup complete."
}

ffind() {
  if [ -z "$1" ]; then
    find . | fzf
  else
    cat "$1" | fzf
  fi
}

connect_to_ec2() { # Connect to EC2 instance after logging into AWS SSO
  aws sso login && ssm-connect.sh ip-10-215-1-63.eu-west-1.compute.internal
}

del() { # Move files to Trash instead of deleting them
  for file in "$@"; do
    mv -iv -- "$file" ~/.Trash/
  done
}

cht() {
  local query=$(echo "$@" | tr ' ' '+')
  curl cht.sh/$query
}

# Prompt
autoload -Uz vcs_info # Load version control information
precmd() {vcs_info}   # Run vcs_info before each prompt

zstyle ':vcs_info:git:*' formats 'on %b' # Format the git branch info

setopt PROMPT_SUBST # Enable prompt string substitution

# Define a function to check for changes in a Git repository
check_git_changes() {
  # Ensure we are inside a Git repository
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Check for unstaged changes or untracked files
    if ! git diff --quiet || git ls-files --others --exclude-standard | grep -q .; then
      echo "unstaged"
    # Check for staged changes that are uncommitted
    elif ! git diff --cached --quiet; then
      echo "staged"
    else
      echo "clean"
    fi
  else
    echo "not_in_git_repo"
  fi
}

# Define a prompt function
my_prompt() {
  # Only set Git prompt if inside a Git repository
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Get current branch name, falling back if not defined
    local branch_name=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

    # Set basic prompt format for directory path
    local prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"

    # Check for changes if branch name is available
    if [[ -n $branch_name ]]; then
      # Determine change status
      local changes=$(check_git_changes)
      if [[ $changes == "unstaged" ]]; then
        prompt="$prompt %{$fg[red]%}($branch_name)%{$reset_color%}" # red for unstaged changes
      elif [[ $changes == "staged" ]]; then
        prompt="$prompt %{$fg[blue]%}($branch_name)%{$reset_color%}" # blue for staged changes
      elif [[ $changes == "clean" ]]; then
        prompt="$prompt %{$fg[green]%}($branch_name)%{$reset_color%}" # green if clean
      fi
    fi
  else
    # Basic prompt for non-Git directories
    local prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"
  fi

  # Add final prompt symbol
  prompt="$prompt %B%{$reset_color%}$%b "

  # Print prompt
  echo -n "$prompt"
}

# Set the prompt
PROMPT='$(my_prompt)'

# History in cache directory:
HISTSIZE=10000                # Set the maximum number of commands to remember in the command history
SAVEHIST=10000                # Set the maximum number of history events to save in the history file
HISTFILE=~/.cache/zsh/history # Set the file to save history

autoload -U colors && colors # Load the colors module

md_to_rtf() {
  # Check if the input file is provided
  if [ -z "$1" ]; then
    echo "Please provide the path to the markdown file."
    return 1
  fi

  # Get the full path of the markdown file
  local md_file="$1"

  # Extract the directory and filename without extension
  local dir=$(dirname "$md_file")
  local filename=$(basename "$md_file" .md)

  # Define the output RTF file path
  local rtf_file="${dir}/${filename}.rtf"

  # Check if the RTF file already exists and notify user
  if [ -f "$rtf_file" ]; then
    echo "RTF file ${rtf_file} already exists. It will be replaced."
  fi

  # Convert the markdown file to RTF using pandoc (overwrites if exists)
  pandoc -f markdown -s "$md_file" -o "$rtf_file"

  # Check if the conversion was successful
  if [ $? -ne 0 ]; then
    echo "Failed to convert markdown to RTF."
    return 1
  fi

  # Copy the contents of the RTF file to the clipboard
  cat "$rtf_file" | pbcopy

  # Confirm the action
  echo "RTF file created at ${rtf_file} and copied to clipboard."
}

function clean_branches() {
  # Get all local branches, excluding the current branch (marked with `*`) and trim whitespace
  local all_branches=$(git branch | sed 's/^\* //;s/^ *//;s/ *$//')

  # Display all branches to the user in a readable format
  echo "Available branches:"
  echo "-------------------"
  echo "$all_branches" | sed 's/^/  - /'
  echo

  # Prompt the user to enter branches to keep
  echo "Enter the branches to keep (space-separated), or press Enter to cancel:"
  read -r keep_branches

  # Exit if no input is given
  if [ -z "$keep_branches" ]; then
    echo "Operation cancelled. No branches deleted."
    return 0
  fi

  # Convert the input into an array of branches to keep
  local keep_array=(${keep_branches})

  # Filter branches to delete
  local branches_to_delete=$(echo "$all_branches" | while read -r branch; do
    if [[ ! " ${keep_array[@]} " =~ " ${branch} " ]]; then
      echo "$branch"
    fi
  done)

  # If there are no branches to delete, exit early
  if [ -z "$branches_to_delete" ]; then
    echo "No branches to delete."
    return 0
  fi

  # Display branches to delete in a readable format
  echo
  echo "Branches to be deleted:"
  echo "-----------------------"
  echo "$branches_to_delete" | sed 's/^/  - /'
  echo

  # Confirm deletion
  echo "Are you sure you want to delete these branches? (y/N):"
  read -r confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    echo "$branches_to_delete" | xargs git branch -D
    echo "Deleted branches."
  else
    echo "Operation cancelled. No branches deleted."
  fi
}

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

zstyle ':completion:*' list-prompt   ''
zstyle ':completion:*' select-prompt ''

# Run the following command at the end of the shell config file
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh