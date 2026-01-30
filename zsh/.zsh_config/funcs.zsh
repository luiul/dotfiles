find-duplicate-filenames() {
    # Default values
    local root_dir="."
    local filter_dir_name_regex=""
    local show_help=0

    # Parse arguments
    for arg in "$@"; do
        case $arg in
        --help | -h)
            show_help=1
            ;;
        --root=*)
            root_dir="${arg#*=}"
            ;;
        --dir-name-regex=*)
            filter_dir_name_regex="${arg#*=}"
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Use --help for usage information."
            return 1
            ;;
        esac
    done

    # Show help if requested
    if [[ "$show_help" -eq 1 ]]; then
        echo "Usage: find-duplicate-filenames --root=DIR [--dir-name-regex=REGEX]"
        echo ""
        echo "Recursively find files with duplicate names (same basename) and list all their full paths."
        echo ""
        echo "Arguments:"
        echo "  --root=DIR               Root directory to start searching from. Defaults to current directory."
        echo "  --dir-name-regex=REGEX   (Optional) Only search inside subdirectories whose NAMES match this regex."
        echo "                           The regex is applied to the last part of the directory path (not full path)."
        echo "  --help                   Show this help message."
        echo ""
        echo "Examples:"
        echo "  find-duplicate-filenames --root=."
        echo "  find-duplicate-filenames --root=/projects --dir-name-regex='^ops'"
        echo "  find-duplicate-filenames --root=/data --dir-name-regex='log'"
        echo "  find-duplicate-filenames --root=/src --dir-name-regex='-data$'"
        return
    fi

    # Validate root directory
    if [[ ! -d "$root_dir" ]]; then
        echo "Error: Directory '$root_dir' not found."
        return 1
    fi

    # Find all file paths under matching directories
    if [[ -n "$filter_dir_name_regex" ]]; then
        find "$root_dir" -type d | grep -E "/[^/]*${filter_dir_name_regex}[^/]*$" | while read -r dir; do
            find "$dir" -type f
        done
    else
        find "$root_dir" -type f
    fi |
        awk -F/ '
        {
            filename = $NF
            files[filename] = files[filename] ? files[filename] ORS $0 : $0
            counts[filename]++
        }
        END {
            for (name in counts) {
                if (counts[name] > 1) {
                    print "Duplicate filename: " name
                    print files[name]
                    print ""
                }
            }
        }
    '
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
    local dry_run=false
    local delete_remote=false
    local force_delete=false

    # Parse optional flags
    for arg in "$@"; do
        case $arg in
        --dry-run)
            dry_run=true
            shift
            ;;
        --remote)
            delete_remote=true
            shift
            ;;
        --force)
            force_delete=true
            shift
            ;;
        *)
            echo "Usage: gdeletemerged [--dry-run] [--remote] [--force]"
            return 1
            ;;
        esac
    done

    # Color helpers
    RED=$(tput setaf 1)
    GREEN=$(tput setaf 2)
    YELLOW=$(tput setaf 3)
    CYAN=$(tput setaf 6)
    RESET=$(tput sgr0)

    # Check for GitHub CLI
    if ! command -v gh >/dev/null 2>&1; then
        echo "${RED}❌ GitHub CLI (gh) not found. Install it: https://cli.github.com/${RESET}"
        return 1
    fi

    echo "${CYAN}🔄 Fetching merged PRs from GitHub...${RESET}"

    # Try fetching merged PRs into main
    merged_pr_branches=$(gh pr list --state merged --base main --json headRefName --jq '.[].headRefName')

    # If nothing found, try master
    if [ -z "$merged_pr_branches" ]; then
        merged_pr_branches=$(gh pr list --state merged --base master --json headRefName --jq '.[].headRefName')
    fi

    if [ -z "$merged_pr_branches" ]; then
        echo "${YELLOW}⚠️  No merged PRs found into main or master.${RESET}"
        return 0
    fi

    echo "${GREEN}✅ Found merged PRs. Checking local branches...${RESET}"

    local deleted_branches=()
    local skipped_branches=()

    for local_branch in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
        if [[ "$local_branch" == "main" || "$local_branch" == "master" ]]; then
            continue
        fi

        if echo "$merged_pr_branches" | grep -qx "$local_branch"; then
            echo "${YELLOW}🗑️  Found merged branch: $local_branch${RESET}"

            if [ "$dry_run" = true ]; then
                echo "   ${CYAN}Would delete: $local_branch${RESET}"
                continue
            fi

            git branch -d "$local_branch" 2>/dev/null
            if [ $? -ne 0 ]; then
                if [ "$force_delete" = true ]; then
                    echo "   ${RED}Normal delete failed. Forcing with -D...${RESET}"
                    git branch -D "$local_branch"
                    deleted_branches+=("$local_branch")
                else
                    echo -n "   ${RED}Delete failed. Force delete with -D? (y/n): ${RESET}"
                    read confirm_force
                    if [[ "$confirm_force" == "y" ]]; then
                        git branch -D "$local_branch"
                        deleted_branches+=("$local_branch")
                    else
                        skipped_branches+=("$local_branch")
                        echo "   ${YELLOW}Skipped: $local_branch${RESET}"
                    fi
                fi
            else
                deleted_branches+=("$local_branch")
            fi

            # Optionally delete remote branch
            if [ "$delete_remote" = true ]; then
                echo "   ${CYAN}Deleting remote branch: origin/$local_branch${RESET}"
                git push origin --delete "$local_branch" 2>/dev/null
            fi
        fi
    done

    echo
    echo "${CYAN}🧹 Cleanup Summary:${RESET}"
    echo "${GREEN}Deleted: ${#deleted_branches[@]}${RESET}"
    for b in "${deleted_branches[@]}"; do
        echo "  ✅ $b"
    done

    if [ ${#skipped_branches[@]} -gt 0 ]; then
        echo "${YELLOW}Skipped: ${#skipped_branches[@]}${RESET}"
        for b in "${skipped_branches[@]}"; do
            echo "  ⚠️  $b"
        done
    fi

    echo "${CYAN}Done.${RESET}"
}

grestorefile() {
    if [[ $# -lt 2 ]]; then
        echo "Usage: git-restore-file <commit> <file-path>"
        return 1
    fi

    local commit=$1
    local file_path=$2

    git restore --source="$commit" --staged --worktree "$file_path"
}

# Recursively activate a Python virtual environment up the directory tree
activate() {
    echo "🐍 Activating Python virtual environment..."

    # Resolve the current directory to its real (non-symlinked) path
    current_dir=$(realpath "$(pwd)")

    while [ "$current_dir" != "/" ]; do
        echo "📂 Checking in: $current_dir"

        for venv_dir in ".venv" "venv"; do
            activate_path="$current_dir/$venv_dir/bin/activate"
            if [ -f "$activate_path" ]; then
                source "$activate_path"
                echo "✅ Activated $venv_dir in $current_dir"
                return 0
            fi
        done

        current_dir=$(dirname "$current_dir")
    done

    echo "No Python virtual environment found."
    return 1
}

remove-pycache() {
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
    read -r confirm
    if [[ "$confirm" == "y" ]]; then
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

delete-git-artifacts() {
    echo "WARNING: This will permanently delete the .git directory and all .git* files from the current directory and its subdirectories."
    echo -n "Are you sure you want to proceed? (y/N): "
    read -r confirm

    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        echo "Removing .git directory..."
        rm -rf .git

        echo "Removing all .git* files and directories..."
        find . -name ".git*" -exec rm -rf {} +

        echo "Git artifacts cleanup completed."
    else
        echo "Operation canceled."
    fi
}

replace-in-file() {
    local file=$1
    local search_string=$2
    local replace_string=$3

    if [[ -z $file || -z $search_string || -z $replace_string ]]; then
        echo "Usage: replace-in-file <file> <search_string> <replace_string>"
        echo "Example: replace-in-file ~/.zshrc \"/Users/luisaceituno\" \"\$HOME\""
        return 1
    fi

    if [[ -f $file ]]; then
        echo "You are about to replace all occurrences of '${search_string}' with '${replace_string}' in ${file}."
        echo "Do you want to proceed? (y/n)"
        read -r confirm

        if [[ $confirm == "y" || $confirm == "Y" ]]; then
            sed -i '' "s|${search_string}|${replace_string}|g" "$file" &&
                echo "Replaced all occurrences of '${search_string}' with '${replace_string}' in ${file}."
        else
            echo "Operation canceled."
        fi
    else
        echo "Error: File '${file}' not found."
        return 1
    fi
}

md-to-rtf() {
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

gcleanbranches() {
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

gupdatebranch() {
    if [ -z "$1" ]; then
        echo "Usage: gupdatebranch <branch-name>"
        return 1
    fi

    current_branch=$(git symbolic-ref --short HEAD)

    if [ "$current_branch" = "$1" ]; then
        echo "You are currently on '$1'. Cannot update a checked-out branch."
        return 1
    fi

    git fetch origin "$1:$1" && echo "Local '$1' updated from origin"
}

gwhichremote() {
    branch=${1:-$(git symbolic-ref --short HEAD)}
    git for-each-ref --format='%(upstream:short)' refs/heads/"$branch"
}

runprecommit() {
    timestamp() {
        date '+%H:%M:%S'
    }

    show_help() {
        cat <<EOF
Usage: runprecommit [options]

Run pre-commit hooks on the diff between two Git refs.

Options:
  --from <ref>      Git ref to diff from (default: origin/master)
  --to <ref>        Git ref to diff to (default: HEAD)
  --verbose         Show verbose output during pre-commit execution
  --help            Show this help message and exit

Examples:
  runprecommit --from main --to HEAD
  runprecommit --verbose
  runprecommit --help
EOF
    }

    # Defaults
    local from_ref="origin/master"
    local to_ref="HEAD"
    local verbose=false

    # Parse optional args
    while [[ $# -gt 0 ]]; do
        case "$1" in
        --from)
            from_ref="$2"
            shift 2
            ;;
        --to)
            to_ref="$2"
            shift 2
            ;;
        --verbose)
            verbose=true
            shift
            ;;
        --help)
            show_help
            return 0
            ;;
        *)
            echo "$(timestamp) ❌ Unknown option: $1"
            echo "Run 'runprecommit --help' for usage."
            return 1
            ;;
        esac
    done

    echo "$(timestamp) 🔍 Checking files changed between 🔁 $from_ref and 📍 $to_ref"
    git diff --name-only "$from_ref"..."$to_ref"

    echo ""
    read "?$(timestamp) ❓ Run pre-commit on these files? (y/n) " confirm

    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        echo "$(timestamp) 🚀 Running pre-commit hooks..."
        if $verbose; then
            pre-commit run --from-ref "$from_ref" --to-ref "$to_ref" --verbose
        else
            pre-commit run --from-ref "$from_ref" --to-ref "$to_ref"
        fi
    else
        echo "$(timestamp) ⏭️ Skipping pre-commit run"
    fi
}

gpullall() {
    for dir in */; do
        if [ -d "$dir/.git" ]; then
            echo "🔄 Updating repo: $dir"
            (
                cd "$dir" || continue
                git fetch --prune && git pull --recurse-submodules
            )
        fi
    done
}

gac() {
    # Ensure we're inside a Git repo
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        echo "❌ Not inside a Git repository."
        return 1
    fi

    # Stage all changes
    git add .

    # Check if pre-commit is configured
    if [ -f ".pre-commit-config.yaml" ]; then
        echo "🛡️  pre-commit detected."
    fi

    local msg="$1"

    if [[ -z "$msg" ]]; then
        echo "📝 No commit message provided. Launching default commit editor..."
        git commit
        return $?
    fi

    # Trim leading/trailing whitespace
    local trimmed_msg
    trimmed_msg=$(echo "$msg" | awk '{$1=$1; print}')

    if [[ -z "$trimmed_msg" ]]; then
        echo "❌ Commit message cannot be empty after trimming."
        return 1
    fi

    # Copy to clipboard
    echo "$trimmed_msg" | pbcopy
    echo "📋 Commit message copied to clipboard."

    # Perform the commit with the message
    git commit -m "$trimmed_msg"
}

gsquashmergehere() {
    if [[ "$1" == "--help" || "$1" == "-h" ]]; then
        echo ""
        echo "📌 squash-merge-here"
        echo ""
        echo "Prompts for a source branch and squash merges it into the current branch."
        echo "Creates a new branch and commits the squash with a conventional message."
        echo ""
        echo "🔧 Usage:"
        echo "  squash-merge-here"
        echo ""
        echo "🧠 Workflow:"
        echo "  1. Prompts for source branch"
        echo "  2. Updates source branch"
        echo "  3. Checks out current branch as target"
        echo "  4. Creates a new branch: <target_branch>__into_<target_prefix>_from_<source_branch>"
        echo "  5. Squash merges source branch"
        echo "  6. Commits with: chore: squash merge '<source>' into '<target>'"
        echo ""
        return 0
    fi

    local target_branch
    target_branch=$(git symbolic-ref --short HEAD)

    echo "🧩 You are currently on: '$target_branch'"

    echo ""
    echo "📂 Available local branches:"
    git branch --format="  - %(refname:short)" | grep -v "^\*"

    echo ""
    echo -n "🔍 Enter the source branch to squash merge from: "
    read source_branch

    if [[ -z "$source_branch" ]]; then
        echo "❌ Source branch is required."
        return 1
    fi

    if [[ "$source_branch" == "$target_branch" ]]; then
        echo "🚫 Source and target branch cannot be the same."
        return 1
    fi

    echo "🚧 You’re about to squash merge changes into '$target_branch' from '$source_branch'."
    echo -n "❓ Proceed with this operation? (y/n): "
    read confirm
    if [[ "$confirm" != "y" ]]; then
        echo "❌ Operation cancelled by user."
        return 1
    fi

    # Fetch and update source branch
    git fetch origin "$source_branch" || return 1
    git checkout "$source_branch" && git pull origin "$source_branch" || return 1
    git checkout "$target_branch" || return 1

    # Extract prefix from target branch (e.g. 'feature' from 'feature/ISA-1234')
    local target_prefix="${target_branch%%/*}"

    # Clean source branch for use in new branch name (replace slashes)
    local safe_source_branch="${source_branch//\//-}"

    # Build new branch name
    local base_name="${target_branch}__into__${target_prefix}__from__${safe_source_branch}"
    echo -n "🔧 Enter new branch name (default: $base_name): "
    read new_branch
    new_branch=${new_branch:-$base_name}

    git checkout -b "$new_branch" || return 1

    # Perform squash merge
    git merge --squash "$source_branch" || return 1

    local commit_msg="chore: squash merge '$source_branch' into '$target_branch'"
    git commit -m "$commit_msg" || return 1

    echo "✅ Squash merge complete on branch: $new_branch"
}

gbranch() {
    # Show help if requested
    if [[ "$1" == "-h" || "$1" == "--help" ]]; then
        echo "📘 Usage: branch [OPTIONS]"
        echo
        echo "Options:"
        echo "  -p, --push        Push the created branch to origin"
        echo "  -v, --verbose     Use verbose format: <type>/<parent>_<JIRA-TICKET>_<desc>"
        echo "  -h, --help        Show this help message"
        return 0
    fi

    local push_flag=false
    local verbose_flag=false

    # Parse flags
    while [[ "$1" != "" ]]; do
        case "$1" in
        -p | --push)
            push_flag=true
            ;;
        -v | --verbose)
            verbose_flag=true
            ;;
        *)
            echo "❌ Error: Invalid option $1"
            return 1
            ;;
        esac
        shift
    done

    # Helpers
    function prompt_for_input() {
        local prompt_message="$1"
        local input_value=""
        while true; do
            read "input_value?$prompt_message"
            if [[ -z "$input_value" ]]; then
                echo "⚠️  Input is required."
            else
                echo "$input_value"
                return 0
            fi
        done
    }

    function clean_string() {
        echo "$1" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-' | tr -cd '[:alnum:]-'
    }

    # Branch type
    local valid_branch_types=("major" "minor" "patch" "issue" "hotfix" "feature" "release")
    local branch_type
    while true; do
        branch_type=$(prompt_for_input "🔧 Enter branch type (${valid_branch_types[*]}): ")
        if [[ " ${valid_branch_types[@]} " =~ " $branch_type " ]]; then
            break
        else
            echo "❌ Invalid type. Use one of: ${valid_branch_types[*]}"
        fi
    done

    # Jira ticket
    local jira_ticket
    while true; do
        jira_ticket=$(prompt_for_input "🎫 Enter Jira ticket (e.g., ISA-1234): ")
        if [[ "$jira_ticket" =~ ^[A-Z]+-[0-9]+$ ]]; then
            break
        else
            echo "❌ Invalid format. Use format: ABC-123"
        fi
    done

    # Description
    local description
    description=$(prompt_for_input "📝 Enter task description: ")
    local clean_description=$(clean_string "$description")

    # Optional: Parent task for verbose
    local clean_parent=""
    if $verbose_flag; then
        local parent_task
        parent_task=$(prompt_for_input "� Enter parent task/project: ")
        clean_parent=$(clean_string "$parent_task")
    fi

    # Construct branch name
    local branch_name=""
    if $verbose_flag; then
        branch_name="${branch_type}/${clean_parent}_${jira_ticket}_${clean_description}"
    else
        branch_name="${branch_type}/${jira_ticket}_${clean_description}"
    fi

    # Create branch
    echo "🚀 Creating branch: $branch_name"
    git checkout -b "$branch_name"
    if [[ $? -ne 0 ]]; then
        echo "❌ Git error: Failed to create branch."
        return 1
    fi

    # Optional push
    if $push_flag; then
        echo "📡 Pushing branch to origin..."
        git push origin "$branch_name"
        if [[ $? -ne 0 ]]; then
            echo "❌ Git error: Failed to push branch."
            return 1
        fi
        echo "✅ Branch created and pushed: $branch_name"
    else
        echo "✅ Branch created: $branch_name"
    fi
}

upgrade-tools() {
    brew update
    brew upgrade
    uv tool upgrade --all
}

gurl() {
  # Optional: pass a remote name (default: origin)
  local remote="${1:-origin}"

  # Get the remote URL (works better than parsing `git remote show`)
  local url
  if ! url="$(git remote get-url "$remote" 2>/dev/null)"; then
    echo "gurl: couldn't get URL for remote '$remote' (are you in a git repo?)" >&2
    return 1
  fi

  # Keep the original for display
  local shown_url="$url"

  # Convert SSH/SSH-like URLs to https for browser opening
  # Examples:
  #   git@github.com:org/repo.git     -> https://github.com/org/repo
  #   ssh://git@github.com/org/repo   -> https://github.com/org/repo
  if [[ "$url" =~ ^git@([^:]+):(.+)$ ]]; then
    url="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  elif [[ "$url" =~ ^ssh://git@([^/]+)/(.+)$ ]]; then
    url="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi

  # Strip trailing .git for nicer web URLs
  url="${url%.git}"

  # Show the original remote URL in the terminal
  echo "$shown_url"

  # Open in default browser (macOS `open`, Linux `xdg-open`, WSL `wslview` if available)
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  elif command -v wslview >/dev/null 2>&1; then
    wslview "$url" >/dev/null 2>&1 &
  else
    echo "gurl: couldn't find a way to open the browser (tried: open, xdg-open, wslview)" >&2
    return 2
  fi
}

# Clone multiple git repositories, skipping existing directories
gclone() {
  if [ "$#" -eq 0 ]; then
    echo "Usage: gclone <url1> [url2 ...]"
    return 1
  fi

  for repo in "$@"; do
    local repo_name
    repo_name=$(basename -s .git "$repo")

    if [ -d "$repo_name" ]; then
      echo "⚠️  Skipping '$repo_name' — directory already exists."
      continue
    fi

    echo "⬇️  Cloning $repo..."
    if git clone --recurse-submodules "$repo"; then
      echo "✅ Successfully cloned '$repo_name'"
    else
      echo "❌ Failed to clone '$repo_name'"
    fi
  done
}

# ldel: list matches (case-insensitive) and move them to ~/.Trash after confirm
ldel() {
  emulate -L zsh

  if [ "$#" -lt 1 ]; then
    print "Usage: ldel <pattern>"
    return 1
  fi

  local pattern="$1"
  local -a matches=()

  # list current dir entries, including dotfiles (not . or ..)
  local -a entries
  entries=(*(D))
  # filter: case-insensitive substring match
  local f
  for f in "${entries[@]}"; do
    [[ "$f" == "." || "$f" == ".." ]] && continue
    if [[ "${(L)f}" == *"${(L)pattern}"* ]]; then
      matches+=("$f")
    fi
  done

  if (( ${#matches} == 0 )); then
    print "No matches for: $pattern"
    return 0
  fi

  print "Matches (${#matches}):"
  printf '  %s\n' "${matches[@]}"

  printf "Move ALL of these to Trash? (y/N): "
  local ans
  read -r ans
  if [[ "$ans" != [Yy] ]]; then
    print "Aborted."
    return 0
  fi

  mkdir -p ~/.Trash
  local m ok=0 fail=0
  for m in "${matches[@]}"; do
    if mv -iv -- "$m" ~/.Trash/; then
      ((ok++))
    else
      ((fail++))
    fi
  done
  print "Done. Moved: $ok  Failed: $fail"
}

# Force-reset current branch to origin/<branch>, no diff
gforcereset() {
  # Ensure we are in a git repo
  local branch remote_branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
    echo "❌ Not inside a git repository."
    return 1
  }

  remote_branch="origin/$branch"

  echo "🔍 Current branch: $branch"
  echo "🔗 Will reset to:  $remote_branch"
  echo
  echo "⚠️  This will permanently discard ALL local changes."
  read "?Are you sure? (yes/no): " confirm

  if [[ "$confirm" != "yes" ]]; then
    echo "❌ Aborted."
    return 1
  fi

  echo "🔄 Fetching origin..."
  git fetch origin || return 1

  echo "🧨 Resetting branch to $remote_branch..."
  git reset --hard "$remote_branch" || return 1

  echo
  read "?Clean untracked files too? (yes/no): " do_clean
  if [[ "$do_clean" == "yes" ]]; then
    echo "🧹 Cleaning untracked files..."
    git clean -fd
  fi

  echo "✅ Branch '$branch' is now fully reset to '$remote_branch'."
}

# Start or reuse a single ssh-agent and add your key
ssh_agent_start() {
  local agent_env_file="$HOME/.ssh/agent_env"

  # If we have a saved agent environment, try to reuse it
  if [[ -f "$agent_env_file" ]]; then
    source "$agent_env_file" >/dev/null 2>&1

    # If the agent is alive and responding, we're done
    if ssh-add -l >/dev/null 2>&1; then
      return
    else
      # Dead / invalid agent; clean up and start a fresh one
      rm -f "$agent_env_file"
      unset SSH_AUTH_SOCK SSH_AGENT_PID
    fi
  fi

  # Start a new ssh-agent
  eval "$(ssh-agent -s)" >/dev/null

  # Add your key (change path if your key file is different)
  ssh-add "$HOME/.ssh/id_ed25519" </dev/null

  # Save environment variables so new shells can reuse this agent
  {
    echo "export SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
    echo "export SSH_AGENT_PID=$SSH_AGENT_PID"
  } >! "$agent_env_file"
}
