# Load version control information
autoload -Uz vcs_info

# Load colors module for prompt styling
autoload -U colors && colors

# Enable prompt substitution
setopt PROMPT_SUBST

# Function to check Git repository changes
check_git_changes() {
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # Check for unstaged changes or untracked files
        if ! git diff --quiet || git ls-files --others --exclude-standard | grep -q .; then
            echo "unstaged"
        elif ! git diff --cached --quiet; then
            echo "staged"
        else
            echo "clean"
        fi
    else
        echo "not_in_git_repo"
    fi
}

# Prompt function to dynamically set the prompt
my_prompt() {
    local prompt=""
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # Get the current Git branch name
        local branch_name=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

        # Set the directory path in magenta
        prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"

        if [[ -n $branch_name ]]; then
            # Get the change status
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
        # Non-Git directories
        prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"
    fi

    # Add final prompt symbol
    prompt="$prompt %B%{$reset_color%}$%b "

    # Return the constructed prompt
    echo "$prompt"
}

# Set the dynamic prompt
PROMPT='$(my_prompt)'

# Run vcs_info before each prompt
precmd() {vcs_info}
