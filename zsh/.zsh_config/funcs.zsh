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
        read -r confirm
        if [[ "$confirm" == "y" ]]; then
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

delete_git_artifacts() {
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

replace_in_file() {
    local file=$1
    local search_string=$2
    local replace_string=$3

    if [[ -z $file || -z $search_string || -z $replace_string ]]; then
        echo "Usage: replace_in_file <file> <search_string> <replace_string>"
        echo "Example: replace_in_file ~/.zshrc \"/Users/luisaceituno\" \"\$HOME\""
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
