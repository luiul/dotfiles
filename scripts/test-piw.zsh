#!/bin/zsh -f
# Isolated launchers. Never opens Ghostty or starts Pi.
emulate -L zsh
setopt errexit nounset pipefail

repo=${0:A:h:h}
source "$repo/zsh/.zsh_config/funcs.zsh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/test-piw.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
fixture=${fixture:A}
mkdir -p "$fixture/bin" "$fixture/start" "$fixture/target dir ' quoted"
export PIW_TEST_DIR="$fixture" PIW_TEST_RUNNING=true PIW_TEST_CREATE_EXIT=0 PIW_TEST_OPEN_EXIT=0
printf '%s\n' '#!/bin/zsh -f
if [[ $1 == -e ]]; then
  print -r -- "$PIW_TEST_RUNNING"
  exit 0
fi
printf "%s\0" "$@" > "$PIW_TEST_DIR/apple-args"
/bin/cat > "$PIW_TEST_DIR/apple-source"
exit "$PIW_TEST_CREATE_EXIT"
' > "$fixture/bin/osascript"
printf '%s\n' '#!/bin/zsh -f
printf "%s\0" "$@" > "$PIW_TEST_DIR/open-args"
exit "$PIW_TEST_OPEN_EXIT"
' > "$fixture/bin/open"
chmod +x "$fixture/bin/osascript" "$fixture/bin/open"
export PATH="$fixture/bin:$PATH"
cd() { builtin cd "$@"; }

clear_calls() { command rm -f -- "$fixture/apple-args" "$fixture/apple-source" "$fixture/open-args"; }
fail() { print -u2 -r -- "FAIL: $*"; exit 1; }
local -a apple_args open_args
local boot cold_boot

builtin cd "$fixture/start"
piw "$fixture/target dir ' quoted"
[[ $PWD == "$fixture/target dir ' quoted" ]] || fail 'caller directory was not preserved'
[[ -f "$fixture/apple-args" && ! -f "$fixture/open-args" ]] || fail 'running Ghostty did not use AppleScript only'
while IFS= read -r -d $'\0' arg; do apple_args+=("$arg"); done < "$fixture/apple-args"
[[ ${#apple_args} == 3 && $apple_args[1] == - && $apple_args[2] == "$PWD" ]] || fail 'AppleScript path arguments changed'
boot=$apple_args[3]
[[ $boot == *'stty -icanon -echo min 0 time 0'* && $boot == *'read -k1 -t 0.2'* && $boot == *'read -k1 -t 1'* && $boot == *'exec pi' ]] || fail 'input drain changed'
[[ "$(<"$fixture/apple-source")" == *'quoted form of (item 2 of argv)'* ]] || fail 'boot command is not quoted by AppleScript'
osacompile -o "$fixture/launch.scpt" "$fixture/apple-source"
print -r -- 'PASS: running Ghostty receives the exact directory and one safely quoted boot command'

clear_calls
PIW_TEST_RUNNING=false
piw .
while IFS= read -r -d $'\0' arg; do open_args+=("$arg"); done < "$fixture/open-args"
[[ ${#open_args} == 9 ]] || fail 'unexpected cold launch arguments'
[[ $open_args[1] == -a && $open_args[2] == Ghostty.app && $open_args[3] == --args && $open_args[4] == --window-save-state=never ]] || fail 'single-instance launch changed'
[[ $open_args[5] == "--working-directory=$PWD" && $open_args[6] == -e && $open_args[7] == /bin/zsh && $open_args[8] == -ic ]] || fail 'shell or cwd changed'
cold_boot=$open_args[9]
[[ $cold_boot == "$boot" ]] || fail 'running and cold boot commands differ'
print -r -- 'PASS: cold launch uses the same boot command without creating another app instance'

clear_calls
PIW_TEST_RUNNING=true
hook_calls=0
piw_test_hook() { (( ++hook_calls )); return 0; }
chpwd_functions=(piw_test_hook)
hook_calls=0
piw
[[ $PWD == "$fixture/target dir ' quoted" && -f "$fixture/apple-args" && $hook_calls == 0 ]] || fail 'no argument ran cd or changed cwd'
clear_calls
piw .
[[ $hook_calls == 1 ]] || fail 'explicit current directory skipped configured cd'
clear_calls
local rc=0
piw "$fixture/missing" 2> "$fixture/error" || rc=$?
[[ $rc != 0 && ! -f "$fixture/apple-args" && ! -f "$fixture/open-args" && -s "$fixture/error" ]] || fail 'bad cd still launched'
PIW_TEST_CREATE_EXIT=7
rc=0
piw . 2> "$fixture/error" || rc=$?
[[ $rc == 1 && ! -f "$fixture/open-args" && "$(<"$fixture/error")" == *'no window could be created'* ]] || fail 'creation error triggered another launcher'
PIW_TEST_CREATE_EXIT=0
PIW_TEST_RUNNING=false
PIW_TEST_OPEN_EXIT=9
rc=0
piw . || rc=$?
[[ $rc == 9 ]] || fail 'cold launcher error was swallowed'
clear_calls
PIW_TEST_OPEN_EXIT=0
mkdir -p "$fixture/-dash"
ln -s "$fixture/target dir ' quoted" "$fixture/link"
piw -- "$fixture/-dash"
[[ $PWD == "$fixture/-dash" && -f "$fixture/open-args" ]] || fail 'cd option separator or leading dash path changed'
clear_calls
piw - > "$fixture/stdout"
[[ $PWD == "$fixture/target dir ' quoted" && -f "$fixture/open-args" ]] || fail 'previous directory changed'
clear_calls
piw "$fixture/link"
[[ $PWD == "$fixture/link" && -f "$fixture/open-args" ]] || fail 'symlink path changed'
clear_calls
rc=0
piw one two three 2> "$fixture/error" || rc=$?
[[ $rc != 0 && ! -f "$fixture/open-args" ]] || fail 'too many cd arguments still launched'
clear_calls
cd() { print -u2 -- 'already in the only match'; return 43; }
PIW_TEST_OPEN_EXIT=0
rc=0
piw current 2> "$fixture/error" || rc=$?
[[ $rc == 43 && ! -f "$fixture/apple-args" && ! -f "$fixture/open-args" ]] || fail 'error text converted cd failure into success'
[[ "$(<"$fixture/error")" == 'already in the only match' ]] || fail 'cd error was hidden'
piw
[[ -f "$fixture/open-args" ]] || fail 'no argument did not bypass the failing cd'
clear_calls
cd() { print -u2 -- 'configured cd failed'; return 42; }
rc=0
piw ignored 2> "$fixture/error" || rc=$?
[[ $rc == 42 && ! -f "$fixture/apple-args" && ! -f "$fixture/open-args" ]] || fail 'configured cd status was not preserved'
unfunction cd

# Real zoxide uses a private database and never changes the live registry.
mkdir -p "$fixture/zoxide-data"
export _ZO_DATA_DIR="$fixture/zoxide-data"
eval "$(command zoxide init --cmd cd --hook none zsh)"
command zoxide add "$fixture/target dir ' quoted"
builtin cd "$fixture/start"
piw target
[[ $PWD == "$fixture/target dir ' quoted" && -f "$fixture/open-args" ]] || fail 'fuzzy directory selection changed'
clear_calls
command zoxide add "$fixture/start"
builtin cd "$fixture/start"
rc=0
piw start 2> "$fixture/error" || rc=$?
[[ $rc == 1 && ! -f "$fixture/open-args" && -s "$fixture/error" ]] || fail 'current-only zoxide match did not stay a failure'
hook_calls=0
piw
[[ $PWD == "$fixture/start" && $hook_calls == 0 && -f "$fixture/open-args" ]] || fail 'no argument did not skip zoxide cd'
print -r -- 'PASS: no argument skips cd and hooks; explicit arguments preserve cd errors and zoxide behavior like cod'
