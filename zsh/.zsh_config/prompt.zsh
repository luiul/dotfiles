# Load colors module for prompt styling
autoload -U colors && colors

# Enable prompt substitution
setopt PROMPT_SUBST

# Prevent venvs from modifying PROMPT (handled manually in my_prompt)
export VIRTUAL_ENV_DISABLE_PROMPT=1

# Prompt function to dynamically set the prompt
my_prompt() {
    local exit_code=$1
    local prompt=""
    local venv_info=""

    if [[ -n "$VIRTUAL_ENV" ]] && [[ "$PWD" = "${VIRTUAL_ENV:h}"* ]]; then
        local venv_name="${VIRTUAL_ENV_PROMPT//[()]/}"
        venv_name="${venv_name%% }"
        # Fall back to parent directory name if VIRTUAL_ENV_PROMPT is empty (e.g. uv venvs)
        if [[ -z "$venv_name" ]]; then
            venv_name="${VIRTUAL_ENV:h:t}"
        fi
        venv_info=" %F{149}($venv_name)%f"
    fi

    # Base (time + cwd)
    prompt="%F{245}╭─%f %F{245}[%D{%H:%M:%S}]%f %F{183}%~%f"

    # Locate .git without forking: walk up from $PWD in pure zsh (~0.005ms vs ~8ms for git rev-parse).
    local git_dir="" d="$PWD"
    while [[ "$d" != "/" && -n "$d" ]]; do
        if [[ -d "$d/.git" ]]; then
            git_dir="$d/.git"
            break
        elif [[ -f "$d/.git" ]]; then
            # Worktree or submodule: .git is a file containing "gitdir: <path>"
            local gitfile_content
            IFS= read -r gitfile_content < "$d/.git"
            if [[ "$gitfile_content" == gitdir:* ]]; then
                local rel="${gitfile_content#gitdir: }"
                [[ "$rel" = /* ]] && git_dir="$rel" || git_dir="$d/$rel"
            fi
            break
        fi
        d="${d:h}"
    done

    local git_status
    # --no-optional-locks avoids touching the index lock; --ignore-submodules=all skips submodule scans.
    if [[ -n "$git_dir" ]] && \
       git_status="$(git --no-optional-locks status --porcelain=v2 --branch --ignore-submodules=all 2>/dev/null)"; then

        # Parse branch headers
        local branch_head="" branch_oid="" branch_ab=""
        local header_lines=("${(f)git_status}")
        local line
        for line in "${header_lines[@]}"; do
            case "$line" in
                '# branch.head '*)  branch_head="${line#\# branch.head }" ;;
                '# branch.oid '*)   branch_oid="${line#\# branch.oid }" ;;
                '# branch.ab '*)    branch_ab="${line#\# branch.ab }" ;;
                [12u\?]\ *)         break ;;
            esac
        done

        # Determine ref display
        local git_ref_display=""
        if [[ "$branch_head" == "(detached)" ]]; then
            local tag
            tag="$(git describe --tags --exact-match 2>/dev/null || true)"
            if [[ -n "$tag" ]]; then
                git_ref_display="detached@$tag"
            else
                git_ref_display="detached@${branch_oid[1,7]}"
            fi
        elif [[ -n "$branch_head" ]]; then
            git_ref_display="$branch_head"
        fi

        # Count file statuses from porcelain lines
        local staged_added=0 staged_modified=0 staged_deleted=0
        local unstaged_modified=0 unstaged_deleted=0 untracked=0
        local has_unstaged=0 has_staged=0

        for line in "${header_lines[@]}"; do
            case "$line" in
                '? '*)
                    (( untracked++ ))
                    has_unstaged=1
                    ;;
                '1 '* | '2 '*)
                    local xy="${line:2:2}"
                    local x="${xy[1]}" y="${xy[2]}"
                    case "$x" in
                        A|R) (( staged_added++ ));    has_staged=1 ;;
                        M)   (( staged_modified++ )); has_staged=1 ;;
                        D)   (( staged_deleted++ ));   has_staged=1 ;;
                    esac
                    case "$y" in
                        M) (( unstaged_modified++ )); has_unstaged=1 ;;
                        D) (( unstaged_deleted++ ));   has_unstaged=1 ;;
                    esac
                    ;;
                'u '*)
                    (( unstaged_modified++ ))
                    has_unstaged=1
                    ;;
            esac
        done

        # Branch color by state
        if [[ -n "$git_ref_display" ]]; then
            if (( has_unstaged )); then
                prompt="$prompt %F{210}($git_ref_display)%f"
            elif (( has_staged )); then
                prompt="$prompt %F{117}($git_ref_display)%f"
            else
                prompt="$prompt %F{114}($git_ref_display)%f"
            fi
        fi

        # Ahead/behind (from branch header)
        if [[ -n "$branch_ab" ]]; then
            local ahead="${branch_ab[(w)1]#+}"
            local behind="${branch_ab[(w)2]#-}"
            local ab_parts=()
            (( ahead > 0 ))  && ab_parts+=("%F{114}↑${ahead}%f")
            (( behind > 0 )) && ab_parts+=("%F{210}↓${behind}%f")
            if (( ${#ab_parts[@]} > 0 )); then
                prompt="$prompt ${(j: :)ab_parts}"
            fi
        fi

        # Stash count (read reflog file directly, no subprocess)
        local stash_reflog="$git_dir/logs/refs/stash"
        if [[ -f "$stash_reflog" ]]; then
            local stash_count=0
            while IFS= read -r _; do (( stash_count++ )); done < "$stash_reflog"
            if (( stash_count > 0 )); then
                prompt="$prompt %F{222}stash:${stash_count}%f"
            fi
        fi

        # Merge/rebase/cherry-pick state
        if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
            prompt="$prompt %F{203}%BREBASING%b%f"
        elif [[ -f "$git_dir/MERGE_HEAD" ]]; then
            prompt="$prompt %F{203}%BMERGING%b%f"
        elif [[ -f "$git_dir/CHERRY_PICK_HEAD" ]]; then
            prompt="$prompt %F{203}%BCHERRY-PICKING%b%f"
        fi

        # File status counts
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
