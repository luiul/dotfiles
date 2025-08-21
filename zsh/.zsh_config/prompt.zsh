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

    # Get the current time
    local current_time="$(date +%H:%M:%S)"

    if [[ -n "$VIRTUAL_ENV_PROMPT" ]]; then
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

    # Base (time + cwd)
    prompt="%B[$current_time]%b %{$fg[magenta]%}%~%{$reset_color%}"

    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # Try to get a branch, otherwise show detached ref
        local git_ref_display=""
        local branch_name
        branch_name="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

        if [[ -n "$branch_name" ]]; then
            git_ref_display="$branch_name"
        else
            # Prefer exact tag, else short SHA
            local tag sha
            tag="$(git describe --tags --exact-match 2>/dev/null || true)"
            if [[ -n "$tag" ]]; then
                git_ref_display="detached@$tag"
            else
                sha="$(git rev-parse --short HEAD 2>/dev/null || true)"
                [[ -n "$sha" ]] && git_ref_display="detached@$sha"
            fi
        fi

        if [[ -n "$git_ref_display" ]]; then
            # Color by repo state (works in detached HEAD too)
            local changes
            changes="$(check_git_changes 2>/dev/null || echo "")"
            case "$changes" in
                unstaged) prompt="$prompt %{$fg[red]%}($git_ref_display)%{$reset_color%}" ;;
                staged)   prompt="$prompt %{$fg[blue]%}($git_ref_display)%{$reset_color%}" ;;
                clean)    prompt="$prompt %{$fg[green]%}($git_ref_display)%{$reset_color%}" ;;
                *)        prompt="$prompt ($git_ref_display)" ;;
            esac
        fi
    fi

    prompt="$prompt$venv_symbol$venv_warning %B%{$reset_color%}$%b "
    echo "$prompt"
}

# Set the dynamic prompt
# (Ensure you have: setopt PROMPT_SUBST; autoload -U colors && colors)
PROMPT='$(my_prompt)'

# Run vcs_info before each prompt (optional; not used by this prompt)
precmd() { vcs_info }