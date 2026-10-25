#!/bin/zsh -f
# Isolated directories and a fake editor. Never opens VS Code.
emulate -L zsh
setopt errexit nounset pipefail

repo=${0:A:h:h}
source "$repo/zsh/.zsh_config/funcs.zsh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/test-cod.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
fixture=${fixture:A}
mkdir -p "$fixture/bin" "$fixture/start" "$fixture/target dir" "$fixture/-dash" "$fixture/zoxide-data"
ln -s "$fixture/target dir" "$fixture/link"
: > "$fixture/plain-file"
export COD_TEST_LOG="$fixture/editor-calls" COD_TEST_EXIT=0
printf '%s\n' '#!/bin/zsh -f
print -r -- "$PWD|$#|$*" >> "$COD_TEST_LOG"
exit "$COD_TEST_EXIT"
' > "$fixture/bin/code"
chmod +x "$fixture/bin/code"
export PATH="$fixture/bin:$PATH"

count=0
hook_calls=0
cod_test_hook() { (( ++hook_calls )); return 0; }
chpwd_functions=(cod_test_hook)

check() {
	local label=$1 expected_rc=$2 expected_pwd=$3 expected_hooks=$4 expected_editor=$5
	shift 5
	builtin cd -- "$fixture/start"
	hook_calls=0
	: > "$COD_TEST_LOG"
	local rc=0
	cod "$@" 2> "$fixture/stderr" || rc=$?
	[[ $rc == $expected_rc && $PWD == $expected_pwd && $hook_calls == $expected_hooks ]] || {
		print -u2 -r -- "FAIL: $label (exit=$rc cwd=$PWD hooks=$hook_calls)"
		exit 1
	}
	local calls="$(<"$COD_TEST_LOG")"
	[[ $calls == $expected_editor ]] || { print -u2 -r -- "FAIL: $label editor calls: $calls"; exit 1; }
	if (( expected_rc != 0 )) && [[ -z $expected_editor ]]; then
		[[ -s "$fixture/stderr" ]] || { print -u2 -r -- "FAIL: $label swallowed error"; exit 1; }
	fi
	(( ++count ))
	print -r -- "PASS: $label"
}

# The wrapper proves cod uses the configured cd, not an internal builtin bypass.
cd() { builtin cd "$@"; }
check 'no argument keeps cwd and skips hooks' 0 "$fixture/start" 0 "$fixture/start|1|."
check 'explicit current directory' 0 "$fixture/start" 1 "$fixture/start|1|." .
check 'absolute path with spaces persists in caller' 0 "$fixture/target dir" 1 "$fixture/target dir|1|." "$fixture/target dir"
check 'relative path with spaces' 0 "$fixture/target dir" 1 "$fixture/target dir|1|." '../target dir'
check 'parent directory' 0 "$fixture" 1 "$fixture|1|." ..
check 'leading dash path' 0 "$fixture/-dash" 1 "$fixture/-dash|1|." ../-dash
check 'cd option separator' 0 "$fixture/-dash" 1 "$fixture/-dash|1|." -- "$fixture/-dash"
check 'previous directory' 0 "$fixture/-dash" 1 "$fixture/-dash|1|." -
check 'symlink path' 0 "$fixture/link" 1 "$fixture/link|1|." "$fixture/link"
check 'cd substring replacement arguments' 0 "$fixture/target dir" 1 "$fixture/target dir|1|." start 'target dir'
check 'missing directory does not open editor' 1 "$fixture/start" 0 '' "$fixture/missing"
check 'file is not a directory' 1 "$fixture/start" 0 '' "$fixture/plain-file"
check 'too many cd arguments fail' 1 "$fixture/start" 0 '' one two three

COD_TEST_EXIT=7
check 'editor exit status without directory change' 7 "$fixture/start" 0 "$fixture/start|1|."
check 'editor failure keeps successful directory change' 7 "$fixture/target dir" 1 "$fixture/target dir|1|." "$fixture/target dir"
COD_TEST_EXIT=0
code() { print -u2 -- 'must not call shadowing function'; return 99; }
check 'uses editor executable, not a shell function' 0 "$fixture/start" 0 "$fixture/start|1|."
unfunction code
saved_path=$PATH
PATH="$fixture/empty-bin"
check 'missing editor returns 127' 127 "$fixture/start" 0 ''
PATH=$saved_path
cd() { print -u2 -- 'configured cd failed'; return 42; }
check 'configured cd failure status is preserved' 42 "$fixture/start" 0 '' ignored
cd() { print -u2 -- 'already in the only match'; return 43; }
check 'error text never converts failure into success' 43 "$fixture/start" 0 '' ignored
check 'no argument bypasses even a failing cd' 0 "$fixture/start" 0 "$fixture/start|1|."
unfunction cd

# Use the actual installed zoxide with a private database, without live hooks.
export _ZO_DATA_DIR="$fixture/zoxide-data"
eval "$(command zoxide init --cmd cd --hook none zsh)"
command zoxide add "$fixture/target dir"
check 'zoxide explicit path' 0 "$fixture/target dir" 1 "$fixture/target dir|1|." "$fixture/target dir"
check 'zoxide fuzzy query' 0 "$fixture/target dir" 1 "$fixture/target dir|1|." target
check 'zoxide no argument keeps cwd' 0 "$fixture/start" 0 "$fixture/start|1|."
# Only the cwd matches, so zoxide must fail just as plain cd does.
command zoxide add "$fixture/start"
check 'zoxide current-only fuzzy match stays a failure' 1 "$fixture/start" 0 '' start

print -r -- "$count tests passed."
