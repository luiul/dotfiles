#!/bin/zsh -f
# Real Git fixtures. No changes to the user's repos or Git settings.
emulate -L zsh
setopt nounset pipefail

repo=${0:A:h:h}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/test-git-prompt.XXXXXX") || exit 1
fixture=${fixture:A}
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid

fail() { print -u2 -r -- "FAIL: $*"; exit 1; }
count=0
pass() { (( ++count )); print -r -- "PASS: $*"; }

mkdir -p "$fixture/plain" "$fixture/filtered" "$fixture/outside" || exit 1
for dir in plain filtered; do
    git init -q "$fixture/$dir" || exit 1
    print -r -- stable > "$fixture/$dir/tracked.txt"
    if [[ $dir == filtered ]]; then
        print -r -- runtime=one >> "$fixture/$dir/tracked.txt"
        print -r -- 'tracked.txt filter=strip-runtime' > "$fixture/$dir/.gitattributes"
        git -C "$fixture/$dir" config filter.strip-runtime.clean "sed '/^runtime=/d'" || exit 1
        git -C "$fixture/$dir" config filter.strip-runtime.required true || exit 1
    fi
    git -C "$fixture/$dir" add . || exit 1
    git -C "$fixture/$dir" -c commit.gpgsign=false commit -qm fixture || exit 1
done

source "$repo/zsh/.zsh_config/aliases_git.zsh"
source "$repo/zsh/.zsh_config/prompt.zsh"
query_calls=0
gitstatus_query() {
    (( ++query_calls ))
    [[ "$*" == *'-t 0 -c _my_prompt_daemon_cb'* ]] || fail 'daemon query must be asynchronous'
    VCS_STATUS_RESULT=ok-sync
    VCS_STATUS_LOCAL_BRANCH=main
    VCS_STATUS_NUM_UNSTAGED=1
    VCS_STATUS_HAS_UNSTAGED=1
    VCS_STATUS_ACTION=''
    return 0
}

# Deliver the worker's real output through the same fd callback as ZLE.
refresh_worker() {
    _my_prompt_dir=$PWD
    _my_prompt_git_worker > "$fixture/result" || fail 'worker failed'
    local fd
    exec {fd}< "$fixture/result"
    _my_prompt_worker_generation=$_my_prompt_generation
    _my_prompt_worker_buffer=""
    _my_prompt_fd=$fd
    _my_prompt_async_cb "$fd" || true  # no active ZLE in this test shell
    (( _my_prompt_fd == -1 )) || fail 'callback leaked its fd'
}

builtin cd "$fixture/plain" || exit 1
rc=0
_my_prompt_gitstatus_update || rc=$?
[[ $rc == 2 && $query_calls == 0 ]] || fail 'unknown filters must use worker first'
pass 'unknown repo does not query daemon'
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 && $_my_prompt_git != *'U['* ]] || fail 'plain clean repo'
pass 'plain clean repo worker result and fd cleanup'
_my_prompt_gitstatus_update || fail 'plain repo did not use daemon'
[[ $query_calls == 1 && $_my_prompt_git == *'U['* ]] || fail 'plain repo daemon result'
pass 'plain repo keeps daemon path'

builtin cd "$fixture/filtered" || exit 1
# Keep the raw size fixed, so Git's stat shortcut cannot mask the clean filter.
print -r -- $'stable\nruntime=two' > tracked.txt
[[ -z $(git status --porcelain) ]] || fail "fixture must be clean after filter: $(git status --porcelain)"
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 && $_my_prompt_git != *'U['* ]] || fail 'filtered-only edits look dirty'
pass 'runtime-only edits match clean Git status'
rc=0
_my_prompt_gitstatus_update || rc=$?
[[ $rc == 2 && $query_calls == 1 ]] || fail 'filtered repo queried daemon'
pass 'filtered repo skips daemon without changing its availability'
print -r -- changed >> tracked.txt
refresh_worker
[[ $_my_prompt_git == *'U[%F{222}~1%f]'* ]] || fail 'real filtered edit missing'
pass 'real edits to filtered files still show modified'
git add tracked.txt || exit 1
refresh_worker
[[ $_my_prompt_git == *'S[%F{117}~1%f]'* && $_my_prompt_git != *'U['* ]] || fail 'staged edit missing'
pass 'staged edits still show staged'
print -r -- new > untracked.txt
refresh_worker
[[ $_my_prompt_git == *'U[%F{152}?1%f]'* ]] || fail 'untracked file missing'
pass 'untracked files still show untracked'
command rm tracked.txt
refresh_worker
[[ $_my_prompt_git == *'U[%F{173}-1%f %F{152}?1%f]'* ]] || fail 'deleted file missing'
pass 'deleted files still show deleted'

# Only process filters also need Git, even without a clean command.
builtin cd "$fixture/plain" || exit 1
git config filter.process-only.process false || exit 1
unset "_my_prompt_git_filters[$PWD]"
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'process filter not detected'
pass 'process filters use Git'
git config --unset filter.process-only.process || exit 1

# Never treat a failed config probe as permission to use the daemon.
unset "_my_prompt_git_filters[$PWD]"
git() {
    if [[ $1 == config ]]; then return 128; fi
    command git "$@"
}
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'failed probe marked safe'
unfunction git
pass 'failed filter probe uses Git'

# A callback for the old directory must not update the new directory's cache.
_my_prompt_dir=$PWD
_my_prompt_git_worker > "$fixture/result"
builtin cd "$fixture/outside" || exit 1
_my_prompt_git='sentinel'
exec {fd}< "$fixture/result"
_my_prompt_worker_generation=$_my_prompt_generation
_my_prompt_worker_buffer=""
_my_prompt_fd=$fd
_my_prompt_async_cb "$fd" || true
[[ $_my_prompt_git == sentinel && ${_my_prompt_git_filters[$PWD]:-unknown} == unknown && $_my_prompt_fd == -1 ]] || fail 'stale callback changed directory state'
pass 'stale directory result is discarded and fd is closed'
refresh_worker
[[ -z $_my_prompt_git ]] || fail 'outside repo shows Git segment'
pass 'outside repo has no Git segment'

# gst is a transparent alias for Git status, including caller arguments.
builtin cd "$fixture/filtered" || exit 1
actual=$(eval 'gst --porcelain') || fail 'gst failed'
expected=$(git status -sb --porcelain) || exit 1
[[ $actual == $expected ]] || fail 'gst differs from Git status'
pass 'gst matches Git status and passes arguments'

# Daemon formatter inputs are explicit, so each parity check starts clean.
mock_status_reset() {
    VCS_STATUS_RESULT=ok-sync
    VCS_STATUS_LOCAL_BRANCH=$(git symbolic-ref --short HEAD) || fail 'mock branch lookup failed'
    VCS_STATUS_TAG='' VCS_STATUS_COMMIT='' VCS_STATUS_ACTION=''
    VCS_STATUS_NUM_STAGED=0 VCS_STATUS_NUM_STAGED_NEW=0 VCS_STATUS_NUM_STAGED_DELETED=0
    VCS_STATUS_NUM_UNSTAGED=0 VCS_STATUS_NUM_UNSTAGED_DELETED=0
    VCS_STATUS_NUM_UNTRACKED=0 VCS_STATUS_NUM_CONFLICTED=0
    VCS_STATUS_HAS_STAGED=0 VCS_STATUS_HAS_UNSTAGED=0
    VCS_STATUS_HAS_UNTRACKED=0 VCS_STATUS_HAS_CONFLICTED=0
    VCS_STATUS_COMMITS_AHEAD=0 VCS_STATUS_COMMITS_BEHIND=0 VCS_STATUS_STASHES=0
}
assert_daemon_parity() {
    local expected=$1
    _my_prompt_gitstatus_segment || fail 'daemon formatter failed'
    [[ $_my_prompt_git == "$expected" ]] || fail "worker/daemon mismatch: $_my_prompt_git != $expected"
}
assert_worker_dispatch() {
    local before=$query_calls rc=0
    _my_prompt_gitstatus_update || rc=$?
    [[ $rc == 2 && $query_calls == $before ]] || fail 'invalid cache queried daemon'
}

mkdir -p "$fixture/cases" || exit 1
git init -q -b main "$fixture/cases" || exit 1
builtin cd "$fixture/cases" || exit 1
print -r -- stable > tracked.txt
print -r -- stable > conflict.txt
git add . && git -c commit.gpgsign=false commit -qm 'regression fixture' || exit 1

# T means a regular file became a symlink, not an addition or deletion.
command rm tracked.txt
ln -s conflict.txt tracked.txt || exit 1
[[ $(git status --porcelain=v2) == '1 .T '* ]] || fail 'unstaged type-change fixture missing T'
refresh_worker
[[ $_my_prompt_git == *'U[%F{222}~1%f]'* && $_my_prompt_git != *'S['* ]] || fail 'unstaged T count'
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_NUM_UNSTAGED=1 VCS_STATUS_HAS_UNSTAGED=1
assert_daemon_parity "$expected"
pass 'unstaged type change counts as modified in both formatters'
git add tracked.txt || exit 1
[[ $(git status --porcelain=v2) == '1 T. '* ]] || fail 'staged type-change fixture missing T'
refresh_worker
[[ $_my_prompt_git == *'S[%F{117}~1%f]'* && $_my_prompt_git != *'U['* ]] || fail 'staged T count'
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_NUM_STAGED=1 VCS_STATUS_HAS_STAGED=1
assert_daemon_parity "$expected"
pass 'staged type change counts as modified in both formatters'
git reset --hard -q HEAD || exit 1

command mv tracked.txt renamed.txt || exit 1
refresh_worker
[[ $_my_prompt_git == *'U[%F{173}-1%f %F{152}?1%f]'* && $_my_prompt_git != *'S['* ]] || fail 'unstaged rename counts'
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_NUM_UNSTAGED=1 VCS_STATUS_NUM_UNSTAGED_DELETED=1 VCS_STATUS_HAS_UNSTAGED=1
VCS_STATUS_NUM_UNTRACKED=1 VCS_STATUS_HAS_UNTRACKED=1
assert_daemon_parity "$expected"
pass 'unstaged rename counts as deletion and untracked addition'
git add -A || exit 1
refresh_worker
[[ $_my_prompt_git == *'S[%F{114}+1%f %F{210}-1%f]'* && $_my_prompt_git != *'U['* ]] || fail 'staged rename counts'
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_NUM_STAGED=2 VCS_STATUS_NUM_STAGED_NEW=1 VCS_STATUS_NUM_STAGED_DELETED=1 VCS_STATUS_HAS_STAGED=1
assert_daemon_parity "$expected"
pass 'staged rename counts as deletion and addition without a modification'
git reset --hard -q HEAD || exit 1

# Both conflicting paths must stay separate from ordinary modified counts.
git switch -qc other || exit 1
print -r -- other > tracked.txt
print -r -- other > conflict.txt
git add . && git -c commit.gpgsign=false commit -qm other || exit 1
git switch -q main || exit 1
print -r -- main > tracked.txt
print -r -- main > conflict.txt
git add . && git -c commit.gpgsign=false commit -qm main || exit 1
rc=0
git -c commit.gpgsign=false merge other > "$fixture/merge.log" 2>&1 || rc=$?
[[ $rc == 1 ]] || fail 'merge fixture did not conflict'
conflict_paths=$(git diff --name-only --diff-filter=U) || exit 1
conflicts=("${(@f)conflict_paths}")
[[ ${#conflicts} == 2 ]] || fail 'merge fixture must have two conflicts'
refresh_worker
[[ $_my_prompt_git == *'%BMERGING%b'* && $_my_prompt_git == *'U[%F{203}!2%f]'* && $_my_prompt_git != *'S['* ]] || fail 'conflicts must show only !2'
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_ACTION=merge VCS_STATUS_NUM_CONFLICTED=2 VCS_STATUS_HAS_CONFLICTED=1
assert_daemon_parity "$expected"
pass 'two merge conflicts show separate !2 and no modified count'
git merge --abort || exit 1

# Percent escapes must survive both the worker record and prompt expansion.
git switch -qc 'topic%F{red}' || exit 1
refresh_worker
[[ $_my_prompt_git == *'(topic%%F{red})'* ]] || fail 'branch percent not escaped'
expected=$_my_prompt_git
mock_status_reset
assert_daemon_parity "$expected"
[[ ${(%)_my_prompt_git} == *'(topic%F{red})'* ]] || fail 'branch percent became prompt markup'
pass 'real percent branch label stays literal through worker and daemon'
git switch -q main || exit 1

# Backslashes are valid display text even though Git forbids them in branch refs.
mock_status_reset
VCS_STATUS_LOCAL_BRANCH='topic\label%F{red}'
_my_prompt_gitstatus_segment || fail 'mock label formatter failed'
[[ $_my_prompt_git == *'(topic\label%%F{red})'* && ${(%)_my_prompt_git} == *'(topic\label%F{red})'* ]] || fail 'daemon backslash/percent label changed'
VCS_STATUS_LOCAL_BRANCH='' VCS_STATUS_TAG='tag\label%F{red}'
_my_prompt_gitstatus_segment || fail 'mock tag formatter failed'
[[ $_my_prompt_git == *'(detached@tag\label%%F{red})'* ]] || fail 'detached label escaping'
pass 'daemon branch and detached tag preserve backslashes and percent labels'

builtin cd "$fixture/outside" || exit 1
refresh_worker
VIRTUAL_ENV="$fixture/venv/.venv" VIRTUAL_ENV_PROMPT='(venv\label%F{red}) '
_my_prompt_render
[[ -z $_my_prompt_git && $PROMPT == *'%F{149}(venv\label%%F{red})%f'* ]] || fail 'outside venv prompt missing or unsafe'
[[ ${(%)PROMPT} == *'(venv\label%F{red})'* ]] || fail 'venv label became prompt markup'
unset VIRTUAL_ENV_PROMPT
VIRTUAL_ENV="$fixture/project%F{red}/.venv"
_my_prompt_render
[[ $PROMPT == *'%F{149}(project%%F{red})%f'* ]] || fail 'venv parent-name fallback missing'
unset VIRTUAL_ENV
pass 'active venv outside Git renders escaped label and parent-name fallback'

# Worktrunk owns creation. The temporary configs contain no hooks or registry writes.
builtin cd "$fixture/cases" || exit 1
print -r -- "worktree-path = \"$fixture/linked\"" > "$fixture/wt.toml"
print -rn -- '' > "$fixture/empty-wt.toml"
WORKTRUNK_AGENT=1 WORKTRUNK_CONFIG_PATH="$fixture/wt.toml" \
    WORKTRUNK_SYSTEM_CONFIG_PATH="$fixture/empty-wt.toml" \
    WORKTRUNK_PROJECT_CONFIG_PATH="$fixture/empty-wt.toml" \
    command wt switch --create linked --no-cd --yes --format json > "$fixture/wt-result.json" 2> "$fixture/wt.log" || fail 'Worktrunk fixture creation failed'
[[ -f "$fixture/linked/.git" ]] || fail 'linked fixture is not a worktree'
# Exercise relative pointers in both the prompt and the window title.
print -r -- 'gitdir: ../cases/.git/worktrees/linked' > "$fixture/linked/.git"
git config -f "$fixture/linked-filter.gitconfig" filter.included.clean cat || exit 1
git config include.path "$fixture/linked-filter.gitconfig" || exit 1
print -r -- stash >> tracked.txt
git stash push -qm 'shared stash' || exit 1
builtin cd "$fixture/linked" || exit 1
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 && $_my_prompt_git == *'stash:1'* && $_my_prompt_git != *'U['* ]] || fail 'linked included filter/shared stash missing'
[[ $_my_prompt_common_dir == "$fixture/cases/.git" && $_my_prompt_repo_dir != "$_my_prompt_common_dir" ]] || fail 'linked private/common dirs not resolved'
assert_worker_dispatch
expected=$_my_prompt_git
mock_status_reset
VCS_STATUS_STASHES=1
assert_daemon_parity "$expected"
pass 'linked worktree honors included filter and shared stash in common Git dir'
source "$repo/zsh/.zsh_config/title.zsh"
add-zsh-hook -d precmd _my_title_precmd
add-zsh-hook -d preexec _my_title_preexec
_my_title_repo_info || fail 'title did not resolve relative worktree pointer'
[[ $_my_title_root == "$fixture/linked" && $_my_title_branch == linked ]] || fail 'relative worktree title mismatch'
pass 'window title resolves relative worktree pointer and branch'
title_output=$(_my_title_render $'test\atitle')
[[ $title_output == $'\e]0;testtitle • '"${(D)PWD}"$' • linked\a' ]] || fail 'title retained injected terminal controls'
pass 'window title strips terminal controls from dynamic text'
builtin cd "$fixture/cases" || exit 1
git config --unset include.path || exit 1
git stash drop -q || exit 1

# HEAD, local config and global config invalidate safe daemon decisions immediately.
git config -f "$fixture/branch-filter.gitconfig" filter.branch.clean cat || exit 1
git config 'includeIf.onbranch:filtered-branch.path' "$fixture/branch-filter.gitconfig" || exit 1
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] && _my_prompt_filter_cached || fail 'branch cache baseline'
git switch -qc filtered-branch || exit 1
_my_prompt_filter_cached && fail 'branch change retained safe cache'
assert_worker_dispatch
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'branch include filter not reprobed'
git switch -q main || exit 1
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] || fail 'branch switch did not restore safe cache'
pass 'branch change invalidates cache and reprobes conditional includes'

git config filter.local.process false || exit 1
_my_prompt_filter_cached && fail 'local config change retained safe cache'
assert_worker_dispatch
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'local config filter not reprobed'
git config --unset filter.local.process || exit 1
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] || fail 'local filter removal not reprobed'
pass 'local config change and filter removal invalidate cache'

export GIT_CONFIG_GLOBAL="$fixture/global.gitconfig"
print -r -- '[test]' > "$GIT_CONFIG_GLOBAL"
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] && _my_prompt_filter_cached || fail 'global cache baseline'
git config -f "$GIT_CONFIG_GLOBAL" filter.global.clean cat || exit 1
_my_prompt_filter_cached && fail 'global config change retained safe cache'
assert_worker_dispatch
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'global config filter not reprobed'
export GIT_CONFIG_GLOBAL=/dev/null
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] || fail 'global filter removal not reprobed'
pass 'global config change invalidates cache and reprobes filters'

print -r -- '[test]' > "$fixture/ttl.gitconfig"
git config include.path "$fixture/ttl.gitconfig" || exit 1
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] || fail 'included config cache baseline'
git config -f "$fixture/ttl.gitconfig" filter.ttl.clean cat || exit 1
_my_prompt_filter_cached || fail 'included file change should wait for TTL'
_my_prompt_git_filter_time[$PWD]=$(( EPOCHSECONDS - 30 ))
_my_prompt_filter_cached && fail '30 second cache did not expire'
assert_worker_dispatch
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'expired included config not reprobed'
git config --unset include.path || exit 1
refresh_worker
pass '30 second TTL invalidates changed included config without sleeping'

# Same-size edits with the same mtime still invalidate the safe filter decision.
builtin cd "$fixture/cases" || exit 1
config_file="$fixture/cases/.git/config"
cp "$config_file" "$fixture/config-original" || exit 1
print -r -- $'[unused "same"]\n\tclean = cat' >> "$config_file"
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 0 ]] && _my_prompt_filter_cached || fail 'same-size baseline not safe'
_my_prompt_dir=$PWD
_my_prompt_worker_generation=$_my_prompt_generation
_my_prompt_git_worker > "$fixture/result"
cp -p "$config_file" "$fixture/config-time" || exit 1
config_text=$(<"$config_file")
print -r -- "${config_text/unused/filter}" > "$config_file"
touch -r "$fixture/config-time" "$config_file" || exit 1
[[ $(wc -c < "$config_file") == $(wc -c < "$fixture/config-time") ]] || fail 'same-size edit changed length'
_my_prompt_filter_cached && fail 'same-size same-mtime edit retained safe cache'
_my_prompt_git=same-size-sentinel
_my_prompt_worker_buffer=''
exec {fd}< "$fixture/result"
_my_prompt_fd=$fd
_my_prompt_async_cb "$fd"
[[ $_my_prompt_git == same-size-sentinel && -z ${_my_prompt_git_filters[$PWD]-} ]] || fail 'same-size edit accepted obsolete worker probe'
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'same-size edit not reprobed'
cp "$fixture/config-original" "$config_file" || exit 1
refresh_worker
pass 'same-size same-mtime config edits reject cached and pending worker results'

# Large config files stay off the input path and cannot enable daemon use.
print -r -- "${(l:65536::#:):-}" >> "$config_file"
refresh_worker
[[ ${_my_prompt_git_filters[$PWD]} == 1 ]] || fail 'large config probe marked safe'
_my_prompt_filter_cached && fail 'large config reused daemon cache'
cp "$fixture/config-original" "$config_file" || exit 1
refresh_worker
pass 'oversized config uses background Git instead of reading it during redraw'

# A daemon timeout returns immediately, retaining one request until its callback.
mock_status_reset
query_calls=0
gitstatus_query() {
    (( ++query_calls ))
    [[ $# == 7 && $1 == -d && $2 == "$PWD" && $3 == -t && $4 == 0 && $5 == -c && $6 == _my_prompt_daemon_cb && $7 == MYPROMPT ]] || fail 'async query arguments changed'
    VCS_STATUS_RESULT=tout
    return 0
}
_my_prompt_git=sentinel
_my_prompt_daemon_pending=0
_my_prompt_gitstatus_update || fail 'async query dispatch failed'
[[ $query_calls == 1 && $_my_prompt_daemon_pending == 1 && $_my_prompt_git == sentinel ]] || fail 'async request not pending'
_my_prompt_gitstatus_update || fail 'pending query update failed'
[[ $query_calls == 1 && $_my_prompt_daemon_pending == 1 ]] || fail 'duplicate pending daemon query'
VCS_STATUS_RESULT=ok-async
VCS_STATUS_NUM_UNTRACKED=1 VCS_STATUS_HAS_UNTRACKED=1
_my_prompt_daemon_cb || fail 'async callback failed'
[[ $_my_prompt_daemon_pending == 0 && $_my_prompt_git == *'U[%F{152}?1%f]'* && $PROMPT == *"$_my_prompt_git"* ]] || fail 'async callback did not publish and render'
pass 'async -t 0 callback renders result with at most one pending request'

# Other shells can change filters without changing this shell's generation.
_my_prompt_gitstatus_update || fail 'config-race query dispatch failed'
git config filter.daemon-race.clean cat || exit 1
_my_prompt_git=daemon-race-sentinel
VCS_STATUS_RESULT=ok-async VCS_STATUS_LOCAL_BRANCH=obsolete
_my_prompt_daemon_cb || fail 'config-race callback failed'
[[ $_my_prompt_git == daemon-race-sentinel && $_my_prompt_daemon_pending == 0 && -z ${_my_prompt_git_filters[$PWD]-} ]] || fail 'changed config accepted daemon result'
git config --unset filter.daemon-race.clean || exit 1
refresh_worker
query_calls=1
pass 'config changes during daemon query discard its result and invalidate cache'

_my_prompt_gitstatus_update || fail 'stale query dispatch failed'
[[ $_my_prompt_daemon_pending == 1 ]] || fail 'stale fixture has no pending query'
(( ++_my_prompt_generation ))
_my_prompt_git='new-generation-sentinel'
VCS_STATUS_RESULT=ok-async VCS_STATUS_LOCAL_BRANCH=obsolete
_my_prompt_daemon_cb || fail 'stale callback failed'
[[ $_my_prompt_git == new-generation-sentinel && $_my_prompt_daemon_pending == 0 && $query_calls == 2 ]] || fail 'old daemon generation overwrote current prompt'
pass 'stale daemon generation result is ignored and pending request is cleared'

# Changing config while a worker runs cannot validate an old probe as safe.
builtin cd "$fixture/cases" || exit 1
_my_prompt_dir=$PWD
_my_prompt_worker_generation=$_my_prompt_generation
_my_prompt_git_worker > "$fixture/result"
git config filter.race.clean cat || exit 1
_my_prompt_git=race-sentinel
_my_prompt_worker_buffer=''
exec {fd}< "$fixture/result"
_my_prompt_fd=$fd
_my_prompt_async_cb "$fd"
[[ $_my_prompt_git == race-sentinel && -z ${_my_prompt_git_filters[$PWD]-} ]] || fail 'changed snapshot accepted old filter result'
git config --unset filter.race.clean || exit 1
pass 'config changes during worker invalidate its original snapshot'

# Native percent formatting stays on, shell substitution stays off.
VIRTUAL_ENV="$fixture/outside/.venv" VIRTUAL_ENV_PROMPT='$(_prompt_payload)'
_prompt_payload() { print -r -- unsafe > "$fixture/prompt-injection"; }
_my_prompt_git=' %F{114}($(_prompt_payload))%f'
_my_prompt_render
print -P -- "$PROMPT" > "$fixture/prompt-rendered"
[[ ! -e "$fixture/prompt-injection" && $(<"$fixture/prompt-rendered") == *'$(_prompt_payload)'* ]] || fail 'prompt ran dynamic label code'
unset VIRTUAL_ENV VIRTUAL_ENV_PROMPT
pass 'command substitutions in prompt labels stay literal'

# Failed Git status is unknown, never a clean or missing repo segment.
git() { return 128; }
failed_segment=$(_my_prompt_git_segment)
unfunction git
[[ $failed_segment == ' %F{245}git:?%f' ]] || fail 'failed Git status looked clean'
pass 'failed Git status shows unknown state'

# A timed-out query resets the daemon and asks for a background fallback.
refresh_calls=0 stop_calls=0
_my_prompt_refresh_git() { (( ++refresh_calls )); return 0; }
gitstatus_stop() { (( ++stop_calls )); return 0; }
_my_prompt_daemon_pending=1
_my_prompt_daemon_generation=$_my_prompt_generation
_my_prompt_gitstatus_ok=1
_my_prompt_daemon_query_timeout "$_my_prompt_generation"
[[ $_my_prompt_daemon_pending == 0 && $_my_prompt_gitstatus_ok == 0 && $refresh_calls == 1 && $stop_calls == 1 ]] || fail 'query timeout did not start fallback'
pass 'daemon query deadline clears state and refreshes fallback'

print -r -- "$count tests passed."
