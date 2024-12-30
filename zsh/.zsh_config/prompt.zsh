# Prompt Configuration
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

# Load the colors module
autoload -U colors && colors
