# Load colors module for prompt styling
autoload -U colors && colors
autoload -Uz add-zsh-hook

# Builtin percent escapes still work. Dynamic labels must never run shell code.
unsetopt PROMPT_SUBST

# Builtin timers, nonblocking reads, and config mtimes. No helper processes.
zmodload zsh/datetime zsh/system zsh/stat zsh/sched

# Prevent venvs from modifying PROMPT (handled manually in my_prompt)
export VIRTUAL_ENV_DISABLE_PROMPT=1

# Git never waits on the input path. Normal repos use an asynchronous daemon
# query. Repos with clean/process filters use background Git, because the
# daemon does not apply those filters. First visits also use background Git.
# Workers publish complete records and have a five-second deadline.
# The daemon starts only after finding a repo where it can be used.

typeset -g _my_prompt_git=""       # last git segment, consumed by my_prompt
typeset -g _my_prompt_fd=-1        # fd of the in-flight subshell worker (-1 = none)
typeset -g _my_prompt_dir=""       # PWD the in-flight worker is computing for
typeset -g _my_prompt_last_exit=0  # exit code of the last foreground command
typeset -g _my_prompt_gitstatus_ok=0
typeset -gA _my_prompt_git_filters=()  # 0 = safe for daemon
typeset -gA _my_prompt_git_filter_time=() _my_prompt_git_filter_key=()
typeset -g _my_prompt_worker_pid=0 _my_prompt_worker_generation=0
typeset -g _my_prompt_worker_group=0
typeset -g _my_prompt_worker_buffer="" _my_prompt_generation=0
typeset -g _my_prompt_command_running=0 _my_prompt_daemon_pending=0
typeset -g _my_prompt_daemon_dir="" _my_prompt_daemon_generation=0
typeset -g _my_prompt_daemon_start_fd=-1 _my_prompt_daemon_attempts=0
typeset -g _my_prompt_daemon_retry=0

# Escape dynamic labels before prompt-percent expansion. Keep terminal controls out.
_my_prompt_label() {
    REPLY=${1//[[:cntrl:]]/}
    REPLY=${REPLY//\%/%%}
}

# Locate private and common Git dirs with builtins, including relative pointers.
_my_prompt_repo_dirs() {
    _my_prompt_repo_dir="" _my_prompt_common_dir=""
    local d=$PWD pointer=""
    while true; do
        if [[ -d "$d/.git" ]]; then
            _my_prompt_repo_dir="$d/.git"
        elif [[ -f "$d/.git" ]]; then
            IFS= read -r pointer < "$d/.git"
            [[ "$pointer" == 'gitdir: '* ]] || return 1
            pointer=${pointer#gitdir: }
            [[ "$pointer" == /* ]] || pointer="$d/$pointer"
            _my_prompt_repo_dir=${pointer:A}
        fi
        [[ -n $_my_prompt_repo_dir ]] && break
        [[ "$d" == / ]] && return 1
        d=${d:h}
    done
    _my_prompt_common_dir=$_my_prompt_repo_dir
    if [[ -r "$_my_prompt_repo_dir/commondir" ]]; then
        IFS= read -r pointer < "$_my_prompt_repo_dir/commondir"
        [[ "$pointer" == /* ]] || pointer="$_my_prompt_repo_dir/$pointer"
        _my_prompt_common_dir=${pointer:A}
    fi
}

# Cheap invalidation for local/global config and branch changes, plus a 30s TTL
# for included config files. All expensive config parsing stays in the worker.
_my_prompt_filter_fingerprint() {
    local file="" key="$PWD|"
    if _my_prompt_repo_dirs; then
        key+="$_my_prompt_repo_dir|$(<"$_my_prompt_repo_dir/HEAD")|"
    fi
    for file in "$_my_prompt_common_dir/config" "$_my_prompt_repo_dir/config.worktree" \
        "${GIT_CONFIG_GLOBAL:-$HOME/.gitconfig}" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config" \
        "${GIT_CONFIG_SYSTEM:-/etc/gitconfig}"; do
        local -a info=()
        if zstat -A info +mtime -- "$file" 2>/dev/null; then
            key+="$file:$info[1]:"
            zstat -A info +size -- "$file" 2>/dev/null && key+="$info[1]|"
        fi
    done
    REPLY=$key
}

_my_prompt_filter_cached() {
    [[ -n ${_my_prompt_git_filters[$PWD]-} ]] || return 1
    (( EPOCHSECONDS - ${_my_prompt_git_filter_time[$PWD]:-0} < 30 )) || return 1
    _my_prompt_filter_fingerprint
    [[ "$REPLY" == "${_my_prompt_git_filter_key[$PWD]-}" ]]
}

# Build ONLY the git segment (single line) from plain `git status`. Runs in the
# background subshell, so the fork+exec of git never blocks the prompt.
_my_prompt_git_segment() {
    local segment=""

    _my_prompt_repo_dirs || { print -rn -- ""; return; }
    local git_dir=$_my_prompt_repo_dir common_dir=$_my_prompt_common_dir
    local git_status
    # Match daemon policy: submodule commit changes count, inner dirt does not.
    # No rename detection: both paths count renames as deletion plus addition.
    if git_status="$(git --no-optional-locks -c status.renames=false status --porcelain=v2 --branch --ignore-submodules=dirty 2>/dev/null)"; then

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
        _my_prompt_label "$git_ref_display"
        git_ref_display=$REPLY

        local unstaged_modified=0 unstaged_deleted=0 untracked=0 conflicted=0
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
                        A|R|C) (( staged_added++ ));    has_staged=1 ;;
                        M|T)   (( staged_modified++ )); has_staged=1 ;;
                        D)   (( staged_deleted++ ));  has_staged=1 ;;
                    esac
                    case "$y" in
                        M|T) (( unstaged_modified++ )); has_unstaged=1 ;;
                        D) (( unstaged_deleted++ ));  has_unstaged=1 ;;
                    esac
                    ;;
                'u '*)
                    (( conflicted++ ))
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
        local stash_reflog="$common_dir/logs/refs/stash"
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
        elif [[ -f "$git_dir/REVERT_HEAD" ]]; then
            segment="$segment %F{203}%BREVERTING%b%f"
        elif [[ -f "$git_dir/BISECT_LOG" ]]; then
            segment="$segment %F{203}%BBISECTING%b%f"
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
        (( conflicted > 0 ))        && unstaged_parts+=("%F{203}!${conflicted}%f")

        if (( ${#staged_parts[@]} > 0 )); then
            segment="$segment S[${(j: :)staged_parts}]"
        fi
        if (( ${#unstaged_parts[@]} > 0 )); then
            segment="$segment U[${(j: :)unstaged_parts}]"
        fi
    else
        segment=' %F{245}git:?%f'
    fi

    print -rn -- "$segment"
}

# Publish only after every command finishes. sysread also guards partial writes.
_my_prompt_git_worker() {
    _my_prompt_filter_fingerprint
    local fingerprint=${(q)REPLY}
    local filters=unknown
    _my_prompt_filter_cached && filters=${_my_prompt_git_filters[$PWD]}
    if [[ "$filters" == unknown ]]; then
        git config --get-regexp '^filter\..*\.(clean|process)$' >/dev/null 2>&1
        local rc=$?
        filters=1
        (( rc == 1 )) && filters=0
    fi
    local segment="$(_my_prompt_git_segment)"
    print -r -- "$filters"$'\t'"$fingerprint"$'\t'"$segment"
}

# Separate dispatch and rendering so callbacks can use the same formatter.
_my_prompt_gitstatus_update() {
    _my_prompt_filter_cached || return 2
    [[ "${_my_prompt_git_filters[$PWD]}" == 0 ]] || return 2
    (( _my_prompt_daemon_pending )) && return 0
    _my_prompt_daemon_pending=1
    _my_prompt_daemon_dir=$PWD
    _my_prompt_daemon_generation=$_my_prompt_generation
    sched +2 "_my_prompt_daemon_query_timeout $_my_prompt_daemon_generation"
    if ! gitstatus_query -d "$PWD" -t 0 -c _my_prompt_daemon_cb MYPROMPT 2>/dev/null; then
        _my_prompt_daemon_pending=0
        _my_prompt_unschedule _my_prompt_daemon_query_timeout
        return 1
    fi
    [[ "$VCS_STATUS_RESULT" == tout ]] || _my_prompt_daemon_cb
    return 0
}

_my_prompt_daemon_query_timeout() {
    (( _my_prompt_daemon_pending && $1 == _my_prompt_daemon_generation )) || return 0
    _my_prompt_daemon_failed
    (( _my_prompt_command_running )) || _my_prompt_refresh_git
}

_my_prompt_daemon_cb() {
    _my_prompt_unschedule _my_prompt_daemon_query_timeout
    _my_prompt_daemon_pending=0
    if [[ "$PWD" != "$_my_prompt_daemon_dir" ]] || \
       (( _my_prompt_generation != _my_prompt_daemon_generation || _my_prompt_command_running )); then
        (( _my_prompt_command_running )) || _my_prompt_refresh_git
        return 0
    fi
    _my_prompt_gitstatus_segment || return 0
    _my_prompt_redraw
}

_my_prompt_gitstatus_segment() {
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

    _my_prompt_label "$git_ref_display"
    git_ref_display=$REPLY

    # Match the plain Git formatter. Conflicts are shown separately.
    local staged_added=${VCS_STATUS_NUM_STAGED_NEW:-0}
    local staged_deleted=${VCS_STATUS_NUM_STAGED_DELETED:-0}
    local staged_modified=$(( ${VCS_STATUS_NUM_STAGED:-0} - staged_added - staged_deleted ))
    local unstaged_deleted=${VCS_STATUS_NUM_UNSTAGED_DELETED:-0}
    local unstaged_modified=$(( ${VCS_STATUS_NUM_UNSTAGED:-0} - unstaged_deleted ))
    local conflicted=${VCS_STATUS_NUM_CONFLICTED:-0}
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
        revert)      segment="$segment %F{203}%BREVERTING%b%f" ;;
        bisect)      segment="$segment %F{203}%BBISECTING%b%f" ;;
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
    (( conflicted > 0 ))        && unstaged_parts+=("%F{203}!${conflicted}%f")

    if (( ${#staged_parts[@]} > 0 )); then
        segment="$segment S[${(j: :)staged_parts}]"
    fi
    if (( ${#unstaged_parts[@]} > 0 )); then
        segment="$segment U[${(j: :)unstaged_parts}]"
    fi

    _my_prompt_git=$segment
}

_my_prompt_redraw() {
    _my_prompt_render
    zle .reset-prompt 2>/dev/null || true
}

# Remove our completed timers, so repeated prompts do not grow the sched queue.
_my_prompt_unschedule() {
    local -i i
    for (( i=${#zsh_scheduled_events}; i>0; --i )); do
        [[ "${zsh_scheduled_events[i]}" == *"::$1 "* ]] && sched -$i
    done
    return 0
}

# Closing a pipe alone does not cancel Git or its filter. Kill the worker group.
_my_prompt_cancel_worker() {
    _my_prompt_unschedule _my_prompt_worker_timeout
    if (( _my_prompt_fd >= 0 )); then
        zle -F $_my_prompt_fd 2>/dev/null
        exec {_my_prompt_fd}<&-
        _my_prompt_fd=-1
    fi
    if (( _my_prompt_worker_pid > 0 )); then
        if (( _my_prompt_worker_group )); then
            kill -KILL -- -$_my_prompt_worker_pid 2>/dev/null
        else
            kill -KILL $_my_prompt_worker_pid 2>/dev/null
        fi
        _my_prompt_worker_pid=0
        _my_prompt_worker_group=0
    fi
    _my_prompt_worker_buffer=""
    return 0
}

_my_prompt_worker_timeout() {
    (( $1 == _my_prompt_worker_generation && _my_prompt_fd >= 0 )) || return 0
    _my_prompt_cancel_worker
    _my_prompt_git=' %F{245}git:?%f'
    _my_prompt_redraw
}

_my_prompt_async_cb() {
    local fd=$1 chunk="" rc=0 result="" segment=""
    (( fd == _my_prompt_fd )) || return 0
    sysread -i $fd -t 0 -s 65536 chunk || rc=$?
    _my_prompt_worker_buffer+=$chunk
    if [[ "$_my_prompt_worker_buffer" != *$'\n'* ]]; then
        (( rc == 5 )) && _my_prompt_cancel_worker
        return 0
    fi
    result=${_my_prompt_worker_buffer%%$'\n'*}
    local generation=$_my_prompt_worker_generation dir=$_my_prompt_dir
    _my_prompt_cancel_worker
    [[ "$PWD" == "$dir" ]] && (( generation == _my_prompt_generation && ! _my_prompt_command_running )) || return 0
    [[ "$result" == [01]$'\t'*$'\t'* ]] || return 0
    local filters=${result%%$'\t'*} payload=${result#*$'\t'}
    local fingerprint=${payload%%$'\t'*}
    _my_prompt_filter_fingerprint
    if [[ "$fingerprint" != "${(q)REPLY}" ]]; then
        unset "_my_prompt_git_filters[$PWD]"
        _my_prompt_refresh_git
        return 0
    fi
    # Preserve the original probe time on cache hits, rather than extending TTL.
    if ! _my_prompt_filter_cached; then
        _my_prompt_git_filter_time[$PWD]=$EPOCHSECONDS
    fi
    _my_prompt_git_filters[$PWD]=$filters
    _my_prompt_git_filter_key[$PWD]=$REPLY
    segment=${payload#*$'\t'}
    _my_prompt_git=$segment
    _my_prompt_redraw
    if [[ "${_my_prompt_git_filters[$PWD]}" == 0 && -n $_my_prompt_repo_dir ]]; then
        _my_prompt_gitstatus_start
    fi
    return 0
}

# Launch without waiting for exec. Finish on pipe readiness, with a 50ms
# handshake bound and at most three attempts per shell.
_my_prompt_gitstatus_start() {
    (( _my_prompt_gitstatus_ok || _my_prompt_daemon_start_fd >= 0 )) && return 0
    (( _my_prompt_daemon_attempts < 3 && EPOCHSECONDS >= _my_prompt_daemon_retry )) || return 0
    (( $+functions[gitstatus_start] )) || return 0
    (( ++_my_prompt_daemon_attempts ))
    if gitstatus_start -a -s -1 -u -1 -c -1 -d -1 MYPROMPT 2>/dev/null; then
        _my_prompt_daemon_start_fd=${_GITSTATUS_RESP_FD_MYPROMPT:--1}
        if (( _my_prompt_daemon_start_fd >= 0 )); then
            zle -F $_my_prompt_daemon_start_fd _my_prompt_daemon_ready 2>/dev/null
            sched +5 "_my_prompt_daemon_timeout $_my_prompt_daemon_attempts"
            return 0
        fi
    fi
    _my_prompt_daemon_failed
}

_my_prompt_daemon_failed() {
    _my_prompt_unschedule _my_prompt_daemon_timeout
    _my_prompt_unschedule _my_prompt_daemon_query_timeout
    if (( _my_prompt_daemon_start_fd >= 0 )); then
        zle -F $_my_prompt_daemon_start_fd 2>/dev/null
    fi
    _my_prompt_daemon_start_fd=-1
    gitstatus_stop MYPROMPT 2>/dev/null
    _my_prompt_gitstatus_ok=0
    _my_prompt_daemon_pending=0
    _my_prompt_daemon_retry=$(( EPOCHSECONDS + 5 ))
    return 0
}

_my_prompt_daemon_timeout() {
    (( $1 == _my_prompt_daemon_attempts && _my_prompt_daemon_start_fd >= 0 )) || return 0
    _my_prompt_daemon_failed
    (( _my_prompt_command_running )) || _my_prompt_refresh_git
}

_my_prompt_daemon_ready() {
    _my_prompt_unschedule _my_prompt_daemon_timeout
    zle -F $_my_prompt_daemon_start_fd 2>/dev/null
    _my_prompt_daemon_start_fd=-1
    if gitstatus_start -t 0.05 -s -1 -u -1 -c -1 -d -1 MYPROMPT 2>/dev/null; then
        _my_prompt_gitstatus_ok=1
        (( _my_prompt_command_running )) || _my_prompt_refresh_git
    else
        _my_prompt_daemon_failed
        (( _my_prompt_command_running )) || _my_prompt_refresh_git
    fi
}

_my_prompt_refresh_git() {
    [[ -o interactive && -t 0 ]] || return 0
    # Always give the worker its own process group, even if the user disabled
    # job control. localoptions restores their preference after launch.
    setopt localoptions monitor
    (( _my_prompt_fd >= 0 )) && return 0
    if ! _my_prompt_repo_dirs; then
        _my_prompt_git=""
        return 0
    fi
    if _my_prompt_filter_cached && [[ ${_my_prompt_git_filters[$PWD]} == 0 ]]; then
        if (( _my_prompt_gitstatus_ok )); then
            _my_prompt_gitstatus_update && return 0
            _my_prompt_daemon_failed
        elif [[ -n $_my_prompt_repo_dir ]]; then
            _my_prompt_gitstatus_start
            # Readiness callback will query the daemon. The last worker result
            # remains valid while it starts, so do not spawn redundant Git.
            (( _my_prompt_daemon_start_fd >= 0 )) && return 0
        fi
    fi
    _my_prompt_dir=$PWD
    _my_prompt_worker_generation=$_my_prompt_generation
    local fd
    exec {fd}< <(_my_prompt_git_worker)
    _my_prompt_worker_pid=$sysparams[procsubstpid]
    _my_prompt_worker_group=1
    _my_prompt_worker_buffer=""
    _my_prompt_fd=$fd
    if zle -F $fd _my_prompt_async_cb 2>/dev/null; then
        sched +5 "_my_prompt_worker_timeout $_my_prompt_worker_generation"
    else
        _my_prompt_cancel_worker
    fi
}

# preexec hook: remember when the command started (for the duration segment)
typeset -gF _my_prompt_cmd_start=0
typeset -g _my_prompt_duration=""
_my_prompt_preexec() {
    _my_prompt_cmd_start=$EPOCHREALTIME
    _my_prompt_command_running=1
    (( ++_my_prompt_generation ))
    _my_prompt_cancel_worker
}

# precmd hook: capture exit code (must stay first), compute duration, refresh git.
_my_prompt_precmd() {
    _my_prompt_last_exit=$?
    _my_prompt_command_running=0
    (( ++_my_prompt_generation ))

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

    _my_prompt_cancel_worker
    _my_prompt_refresh_git
    _my_prompt_render
}

# Clear the segment and cancel previous work when the directory changes.
_my_prompt_chpwd() {
    (( ++_my_prompt_generation ))
    _my_prompt_cancel_worker
    _my_prompt_git=""
}

_my_prompt_shutdown() {
    _my_prompt_cancel_worker
    _my_prompt_unschedule _my_prompt_daemon_timeout
    _my_prompt_unschedule _my_prompt_daemon_query_timeout
    if (( _my_prompt_daemon_start_fd >= 0 )); then
        zle -F $_my_prompt_daemon_start_fd 2>/dev/null
        _my_prompt_daemon_start_fd=-1
    fi
    (( $+functions[gitstatus_stop] )) && gitstatus_stop MYPROMPT 2>/dev/null
    return 0
}

if [[ -o interactive ]]; then
    add-zsh-hook precmd _my_prompt_precmd
    add-zsh-hook preexec _my_prompt_preexec
    add-zsh-hook chpwd _my_prompt_chpwd
    add-zsh-hook zshexit _my_prompt_shutdown
fi

# Source only the API. No daemon is needed in home or in filtered repos.
if [[ -r ~/repos/gitstatus/gitstatus.plugin.zsh ]]; then
    source ~/repos/gitstatus/gitstatus.plugin.zsh 2>/dev/null
fi

# Build in the main shell, not a command substitution on every redraw.
_my_prompt_render() {
    local rendered=""
    local venv_info=""

    if [[ -n "${VIRTUAL_ENV:-}" ]]; then
        local venv_name="${${VIRTUAL_ENV_PROMPT:-}//[()]/}"
        venv_name="${venv_name%% }"
        # Fall back to parent directory name if VIRTUAL_ENV_PROMPT is empty (e.g. uv venvs)
        if [[ -z "$venv_name" ]]; then
            venv_name="${VIRTUAL_ENV:h:t}"
        fi
        _my_prompt_label "$venv_name"
        venv_info=" %F{149}($REPLY)%f"
    fi

    # Base (time + cwd)
    rendered="%F{245}╭─%f %F{245}[%D{%H:%M:%S}]%f %F{183}%~%f"

    # Git updates only replace this cached, already escaped segment.
    rendered="$rendered$_my_prompt_git"

    # Command duration (from preexec/precmd timing)
    [[ -n "$_my_prompt_duration" ]] && rendered="$rendered %F{180}${_my_prompt_duration}%f"

    local exit_indicator=""
    if (( _my_prompt_last_exit != 0 )); then
        exit_indicator=" %F{203}[${_my_prompt_last_exit}]%f"
    fi

    PROMPT="$rendered$venv_info"$'\n'"%F{245}╰─%f %B$%b${exit_indicator} "
}

# Compatibility for callers and tests. Normal rendering never forks this.
my_prompt() {
    _my_prompt_render
    print -r -- "$PROMPT"
}

_my_prompt_render
