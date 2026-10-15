# Load colors module for prompt styling
autoload -U colors && colors
autoload -Uz add-zsh-hook

# Enable prompt substitution
setopt PROMPT_SUBST

# Needed for EPOCHREALTIME (command duration) below
zmodload zsh/datetime

# Prevent venvs from modifying PROMPT (handled manually in my_prompt)
export VIRTUAL_ENV_DISABLE_PROMPT=1

# --- Git segment: gitstatus daemon, with async subshell fallback ---------------
# Two paths, because `git status` fork+exec is taxed ~270ms by SentinelOne:
#
# 1. gitstatusd (preferred): one long-lived daemon per shell, queried in-process
#    (~9ms, no exec). gitstatus_start costs one taxed exec (~0.2-0.4s), so it is
#    deferred with `sched +2` to idle time instead of blocking startup. The
#    query runs in precmd (my_prompt itself runs inside $(...) and cannot set
#    variables), so the segment is fresh on every render.
# 2. Async subshell (fallback until the daemon is up, or if it fails): a
#    background subshell runs plain `git status`; a zle -F fd watcher stores
#    the segment and redraws via `zle .reset-prompt`, so the info pops in ~0.3s
#    after the prompt instead of blocking it. Can be one render stale.
#
# Update gitstatus: git -C ~/repos/gitstatus pull (daemon binary is cached in
# ~/.cache/gitstatus and survives). Revert: delete this block and the gitstatus
# update call in _my_prompt_precmd, keep the async subshell path.

typeset -g _my_prompt_git=""       # last git segment, consumed by my_prompt
typeset -g _my_prompt_fd=-1        # fd of the in-flight subshell worker (-1 = none)
typeset -g _my_prompt_dir=""       # PWD the in-flight worker is computing for
typeset -g _my_prompt_last_exit=0  # exit code of the last foreground command
typeset -g _my_prompt_gitstatus_ok=0

# Build ONLY the git segment (single line) from plain `git status`. Runs in the
# background subshell, so the fork+exec of git never blocks the prompt.
_my_prompt_git_segment() {
    local segment=""

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
                        D)   (( staged_deleted++ ));  has_staged=1 ;;
                    esac
                    case "$y" in
                        M) (( unstaged_modified++ )); has_unstaged=1 ;;
                        D) (( unstaged_deleted++ ));  has_unstaged=1 ;;
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
                segment="$segment %F{210}($git_ref_display)%f"
            elif (( has_staged )); then
                segment="$segment %F{117}($git_ref_display)%f"
            else
                segment="$segment %F{114}($git_ref_display)%f"
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
                segment="$segment ${(j: :)ab_parts}"
            fi
        fi

        # Stash count (read reflog file directly, no subprocess)
        local stash_reflog="$git_dir/logs/refs/stash"
        if [[ -f "$stash_reflog" ]]; then
            local stash_count=0
            while IFS= read -r _; do (( stash_count++ )); done < "$stash_reflog"
            if (( stash_count > 0 )); then
                segment="$segment %F{222}stash:${stash_count}%f"
            fi
        fi

        # Merge/rebase/cherry-pick state
        if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
            segment="$segment %F{203}%BREBASING%b%f"
        elif [[ -f "$git_dir/MERGE_HEAD" ]]; then
            segment="$segment %F{203}%BMERGING%b%f"
        elif [[ -f "$git_dir/CHERRY_PICK_HEAD" ]]; then
            segment="$segment %F{203}%BCHERRY-PICKING%b%f"
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
            segment="$segment S[${(j: :)staged_parts}]"
        fi
        if (( ${#unstaged_parts[@]} > 0 )); then
            segment="$segment U[${(j: :)unstaged_parts}]"
        fi
    fi

    print -rn -- "$segment"
}

# Build the same segment from gitstatusd state. Runs in precmd (main shell).
# Returns 1 when the daemon cannot answer, so the caller re-enables fallback.
_my_prompt_gitstatus_update() {
    gitstatus_query -d "$PWD" -t 0.5 MYPROMPT 2>/dev/null || return 1
    if [[ "$VCS_STATUS_RESULT" == norepo* ]]; then
        _my_prompt_git=""
        return 0
    fi
    [[ "$VCS_STATUS_RESULT" == ok* ]] || return 1

    local segment=""

    # Ref display
    local git_ref_display=""
    if [[ -n "$VCS_STATUS_LOCAL_BRANCH" ]]; then
        git_ref_display=$VCS_STATUS_LOCAL_BRANCH
    elif [[ -n "$VCS_STATUS_TAG" ]]; then
        git_ref_display="detached@$VCS_STATUS_TAG"
    else
        git_ref_display="detached@${VCS_STATUS_COMMIT[1,7]}"
    fi

    # Counts (mirror the porcelain mapping: conflicts count as unstaged modified)
    local staged_added=${VCS_STATUS_NUM_STAGED_NEW:-0}
    local staged_deleted=${VCS_STATUS_NUM_STAGED_DELETED:-0}
    local staged_modified=$(( ${VCS_STATUS_NUM_STAGED:-0} - staged_added - staged_deleted ))
    local unstaged_deleted=${VCS_STATUS_NUM_UNSTAGED_DELETED:-0}
    local unstaged_modified=$(( ${VCS_STATUS_NUM_UNSTAGED:-0} - unstaged_deleted + ${VCS_STATUS_NUM_CONFLICTED:-0} ))
    local untracked=${VCS_STATUS_NUM_UNTRACKED:-0}
    local has_staged=${VCS_STATUS_HAS_STAGED:-0}
    local has_unstaged=$(( ${VCS_STATUS_HAS_UNSTAGED:-0} || ${VCS_STATUS_HAS_CONFLICTED:-0} || ${VCS_STATUS_HAS_UNTRACKED:-0} ))

    # Branch color by state
    if [[ -n "$git_ref_display" ]]; then
        if (( has_unstaged )); then
            segment="$segment %F{210}($git_ref_display)%f"
        elif (( has_staged )); then
            segment="$segment %F{117}($git_ref_display)%f"
        else
            segment="$segment %F{114}($git_ref_display)%f"
        fi
    fi

    # Ahead/behind
    local ab_parts=()
    (( ${VCS_STATUS_COMMITS_AHEAD:-0} > 0 ))  && ab_parts+=("%F{114}↑${VCS_STATUS_COMMITS_AHEAD}%f")
    (( ${VCS_STATUS_COMMITS_BEHIND:-0} > 0 )) && ab_parts+=("%F{210}↓${VCS_STATUS_COMMITS_BEHIND}%f")
    if (( ${#ab_parts[@]} > 0 )); then
        segment="$segment ${(j: :)ab_parts}"
    fi

    # Stash count
    if (( ${VCS_STATUS_STASHES:-0} > 0 )); then
        segment="$segment %F{222}stash:${VCS_STATUS_STASHES}%f"
    fi

    # Merge/rebase/cherry-pick state
    case "$VCS_STATUS_ACTION" in
        merge)       segment="$segment %F{203}%BMERGING%b%f" ;;
        rebase*|am)  segment="$segment %F{203}%BREBASING%b%f" ;;
        cherry-pick) segment="$segment %F{203}%BCHERRY-PICKING%b%f" ;;
    esac

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
        segment="$segment S[${(j: :)staged_parts}]"
    fi
    if (( ${#unstaged_parts[@]} > 0 )); then
        segment="$segment U[${(j: :)unstaged_parts}]"
    fi

    _my_prompt_git=$segment
}

# zle -F callback (fallback path): subshell worker finished, store and redraw.
_my_prompt_async_cb() {
    local fd=$1 segment=""
    IFS= read -r -u $fd segment
    zle -F $fd 2>/dev/null          # unregister watcher
    local closer=$fd
    exec {closer}<&-                # close the fd
    (( _my_prompt_fd == fd )) && _my_prompt_fd=-1
    [[ "$PWD" != "$_my_prompt_dir" ]] && return  # dir changed while worker ran; discard
    [[ "$segment" == "$_my_prompt_git" ]] && return  # no change, no redraw
    _my_prompt_git=$segment
    zle .reset-prompt 2>/dev/null
}

# Deferred daemon start (scheduled on idle; one taxed exec, ~0.2-0.4s once).
_my_prompt_gitstatus_start() {
    (( _my_prompt_gitstatus_ok )) && return
    if gitstatus_start -s -1 -u -1 -d -1 MYPROMPT 2>/dev/null; then
        _my_prompt_gitstatus_ok=1
    fi
}

# preexec hook: remember when the command started (for the duration segment)
typeset -gF _my_prompt_cmd_start=0
typeset -g _my_prompt_duration=""
_my_prompt_preexec() {
    _my_prompt_cmd_start=$EPOCHREALTIME
}

# precmd hook: capture exit code (must stay first), compute duration, refresh git.
_my_prompt_precmd() {
    _my_prompt_last_exit=$?

    # Command duration segment (shown at >= 3s)
    _my_prompt_duration=""
    if (( _my_prompt_cmd_start > 0 )); then
        local -F secs=$(( EPOCHREALTIME - _my_prompt_cmd_start ))
        _my_prompt_cmd_start=0
        local -i isecs=$(( secs ))  # truncates; int() is unavailable in macOS zsh arithmetic
        if (( isecs >= 3 )); then
            if (( isecs >= 60 )); then
                printf -v _my_prompt_duration 'took %dm%02ds' $(( isecs / 60 )) $(( isecs % 60 ))
            else
                printf -v _my_prompt_duration 'took %.1fs' $secs
            fi
        fi
    fi

    # Stop a stale subshell worker (closing the read end SIGPIPEs the orphan)
    if (( _my_prompt_fd >= 0 )); then
        zle -F $_my_prompt_fd 2>/dev/null
        exec {_my_prompt_fd}<&-
        _my_prompt_fd=-1
    fi

    if (( _my_prompt_gitstatus_ok )); then
        # Daemon path: fresh segment, in-process (~9ms, no exec). On failure,
        # drop back to the subshell path below.
        _my_prompt_gitstatus_update && return
        _my_prompt_gitstatus_ok=0
    fi

    # Fallback path: background subshell + zle -F watcher
    _my_prompt_dir=$PWD
    local fd
    exec {fd}< <(_my_prompt_git_segment)
    if zle -F $fd _my_prompt_async_cb 2>/dev/null; then
        _my_prompt_fd=$fd
    else
        # ZLE not active (dumb terminal, script): no watcher, just close
        exec {fd}<&-
    fi
}

# Clear the segment on directory change so the old repo's info never shows.
_my_prompt_chpwd() {
    _my_prompt_git=""
}

add-zsh-hook precmd _my_prompt_precmd
add-zsh-hook preexec _my_prompt_preexec
add-zsh-hook chpwd _my_prompt_chpwd

# gitstatus plugin: source and schedule the deferred daemon start
if [[ -r ~/repos/gitstatus/gitstatus.plugin.zsh ]]; then
    source ~/repos/gitstatus/gitstatus.plugin.zsh 2>/dev/null
    if (( $+functions[gitstatus_start] )); then
        zmodload zsh/sched
        sched +2 _my_prompt_gitstatus_start
        # One retry in case the first start failed (e.g. binary still downloading)
        sched +10 _my_prompt_gitstatus_start
    fi
fi

# Prompt function to dynamically set the prompt
my_prompt() {
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

    # Git segment (fresh from gitstatusd via precmd, or last known async value)
    prompt="$prompt$_my_prompt_git"

    # Command duration (from preexec/precmd timing)
    [[ -n "$_my_prompt_duration" ]] && prompt="$prompt %F{180}${_my_prompt_duration}%f"

    local exit_indicator=""
    if (( _my_prompt_last_exit != 0 )); then
        exit_indicator=" %F{203}[${_my_prompt_last_exit}]%f"
    fi

    prompt="$prompt$venv_info"$'\n'"%F{245}╰─%f %B$%b${exit_indicator} "
    echo "$prompt"
}

# Set the dynamic prompt
PROMPT='$(my_prompt)'
