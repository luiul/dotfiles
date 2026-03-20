# Load colors module for prompt styling
autoload -U colors && colors

# Enable prompt substitution
setopt PROMPT_SUBST

# Prevent venvs from modifying PROMPT (handled manually in my_prompt)
export VIRTUAL_ENV_DISABLE_PROMPT=1

# Function to check Git repository changes
check_git_changes() {
    if ! git diff --quiet || git ls-files --others --exclude-standard | grep -q .; then
        echo "unstaged"
    elif ! git diff --cached --quiet; then
        echo "staged"
    else
        echo "clean"
    fi
}

# Prompt function to dynamically set the prompt
my_prompt() {
    local exit_code=$1
    local prompt=""
    local venv_info=""

    if [[ -n "$VIRTUAL_ENV" ]] && [[ "$PWD" = "$(dirname "$VIRTUAL_ENV")"* ]]; then
        local venv_name
        venv_name="$(echo "$VIRTUAL_ENV_PROMPT" | sed -E 's/^\((.*)\)[[:space:]]*$/\1/')"
        venv_info=" %F{149}($venv_name)%f"
    fi

    # Base (time + cwd)
    prompt="%F{245}╭─%f %F{245}[%D{%H:%M:%S}]%f %F{183}%~%f"

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
                unstaged) prompt="$prompt %F{210}($git_ref_display)%f" ;;
                staged)   prompt="$prompt %F{117}($git_ref_display)%f" ;;
                clean)    prompt="$prompt %F{114}($git_ref_display)%f" ;;
                *)        prompt="$prompt ($git_ref_display)" ;;
            esac
        fi

        # Ahead/behind remote
        local upstream
        upstream="$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)"
        if [[ -n "$upstream" ]]; then
            local ahead behind
            ahead="$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
            behind="$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)"
            local ab_parts=()
            (( ahead > 0 ))  && ab_parts+=("%F{114}↑${ahead}%f")
            (( behind > 0 )) && ab_parts+=("%F{210}↓${behind}%f")
            if (( ${#ab_parts[@]} > 0 )); then
                prompt="$prompt ${(j: :)ab_parts}"
            fi
        fi

        # Stash count
        local stash_count
        stash_count="$(git stash list 2>/dev/null | wc -l | tr -d ' ')"
        if (( stash_count > 0 )); then
            prompt="$prompt %F{222}stash:${stash_count}%f"
        fi

        # Merge/rebase/cherry-pick state
        local git_dir
        git_dir="$(git rev-parse --git-dir 2>/dev/null)"
        if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
            prompt="$prompt %F{203}%BREBASING%b%f"
        elif [[ -f "$git_dir/MERGE_HEAD" ]]; then
            prompt="$prompt %F{203}%BMERGING%b%f"
        elif [[ -f "$git_dir/CHERRY_PICK_HEAD" ]]; then
            prompt="$prompt %F{203}%BCHERRY-PICKING%b%f"
        fi

        # File status counts
        local staged_added staged_modified staged_deleted unstaged_modified unstaged_deleted untracked
        staged_added=$(git diff --cached --diff-filter=A --name-only 2>/dev/null | wc -l | tr -d ' ')
        staged_modified=$(git diff --cached --diff-filter=M --name-only 2>/dev/null | wc -l | tr -d ' ')
        staged_deleted=$(git diff --cached --diff-filter=D --name-only 2>/dev/null | wc -l | tr -d ' ')
        unstaged_modified=$(git diff --diff-filter=M --name-only 2>/dev/null | wc -l | tr -d ' ')
        unstaged_deleted=$(git diff --diff-filter=D --name-only 2>/dev/null | wc -l | tr -d ' ')
        untracked=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

        local staged_parts=()
        (( staged_added > 0 ))    && staged_parts+=("%F{114}+${staged_added}%f")
        (( staged_modified > 0 )) && staged_parts+=("%F{117}~${staged_modified}%f")
        (( staged_deleted > 0 ))  && staged_parts+=("%F{210}-${staged_deleted}%f")

        local unstaged_parts=()
        (( unstaged_modified > 0 )) && unstaged_parts+=("%F{222}~${unstaged_modified}%f")
        (( unstaged_deleted > 0 ))  && unstaged_parts+=("%F{173}-${unstaged_deleted}%f")
        (( untracked > 0 ))         && unstaged_parts+=("%F{152}?${untracked}%f")

        if (( ${#staged_parts[@]} > 0 )); then
            prompt="$prompt S[${(j: :)staged_parts}]"
        fi
        if (( ${#unstaged_parts[@]} > 0 )); then
            prompt="$prompt U[${(j: :)unstaged_parts}]"
        fi
    fi

    local exit_indicator=""
    if (( exit_code != 0 )); then
        exit_indicator=" %F{203}[${exit_code}]%f"
    fi

    prompt="$prompt$venv_info"$'\n'"%F{245}╰─%f %B$%b${exit_indicator} "
    echo "$prompt"
}

# Set the dynamic prompt
PROMPT='$(my_prompt $?)'
