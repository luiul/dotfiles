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

find-duplicate-filenames() {
    # Default values
    local root_dir="."
    local filter_dir_name_regex=""
    local show_help=0

    # Parse arguments
    for arg in "$@"; do
        case $arg in
            --help|-h)
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
    # Read all eligible branches into an array
    local branches=($(git branch --merged | egrep -v "(^\*|master|main)"))

    # Iterate over the array
    for branch in "${branches[@]}"; do
        echo "Deleting branch: $branch"
        echo "Do you want to delete this branch? (y/n)"
        read -r confirm
        if [[ "$confirm" == "y" ]]; then
            git branch -d "$branch"
        fi
    done
}

git-restore-file() {
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
    current_dir=$(pwd)

    while [ "$current_dir" != "/" ]; do
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
        current_dir=$(dirname "$current_dir")
    done

    echo "No Python virtual environment found up to root directory."
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
        git fetch && git pull --recurse-submodules
      )
    fi
  done
}

gac() {
  # Check if we're in a Git repo
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "Not inside a Git repository."
    return 1
  fi

  # Run git add
  git add .

  # Check if the repo uses the pre-commit framework
  if [ -f ".pre-commit-config.yaml" ]; then
    echo "pre-commit detected. Running 'git commit'..."
    git commit
  else
    echo "No pre-commit config found. Running 'git commit -m'..."
    echo -n "Enter commit message: "
    read msg
    git commit -m "$msg"
  fi
}