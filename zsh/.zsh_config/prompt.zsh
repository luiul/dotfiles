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
    local venv_symbol=""
    local venv_warning=""

    if [[ -n "$VIRTUAL_ENV_PROMPT" ]]; then
        # Debug line: shows ASCII codes if you suspect hidden chars
        # echo "$VIRTUAL_ENV_PROMPT" | od -c

        # Use sed to remove the leading "(" and trailing ")" plus any trailing spaces
        local venv_display_name
        venv_display_name="$(
            echo "$VIRTUAL_ENV_PROMPT" | sed -E 's/^\((.*)\)[[:space:]]*$/\1/'
        )"
        local current_dir_name="$(basename "$PWD")"

        venv_symbol=" 🐍"

        if [[ "$venv_display_name" != "$current_dir_name" ]]; then
            venv_warning="❌"
        fi
    fi

    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local branch_name="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
        prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"

        if [[ -n "$branch_name" ]]; then
            local changes="$(check_git_changes)"
            case "$changes" in
            unstaged) prompt="$prompt %{$fg[red]%}($branch_name)%{$reset_color%}" ;;
            staged) prompt="$prompt %{$fg[blue]%}($branch_name)%{$reset_color%}" ;;
            clean) prompt="$prompt %{$fg[green]%}($branch_name)%{$reset_color%}" ;;
            esac
        fi
    else
        prompt="%B%{$fg[magenta]%}%~%{$reset_color%}"
    fi

    prompt="$prompt$venv_symbol$venv_warning %B%{$reset_color%}$%b "
    echo "$prompt"
}

# Set the dynamic prompt
PROMPT='$(my_prompt)'

# Run vcs_info before each prompt
precmd() {vcs_info}
