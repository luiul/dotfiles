#!/bin/zsh -f
# Test only the Mole startup block, with a private Znap cache and fake executable.
emulate -L zsh
setopt errexit nounset pipefail

repo=${0:A:h:h}
znap_root=${ZNAP_TEST_ROOT:-$HOME/repos/znap}
[[ -r "$znap_root/znap.zsh" ]] || {
  print -u2 -r -- "Znap not found: $znap_root (set ZNAP_TEST_ROOT)"
  exit 1
}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/test-zsh-startup.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
fixture=${fixture:A}
mkdir -p "$fixture/bin dir" "$fixture/replacement bin" "$fixture/empty-bin"

# Read the actual startup block rather than maintain a copy of its behavior.
block=''
found=0
while IFS= read -r line; do
  [[ $line == '# Cache Mole completion output.'* ]] && found=1
  (( found )) && block+="$line"$'\n'
done < "$repo/zsh/.zshrc"
[[ -n $block ]] || { print -u2 -- 'FAIL: Mole startup block not found'; exit 1; }
print -rn -- "$block" > "$fixture/startup.zsh"

export MOLE_TEST_LOG="$fixture/generations"
: > "$MOLE_TEST_LOG"
print -r -- '#!/bin/zsh -f
[[ $# == 2 && $1 == completion && $2 == zsh ]] || exit 2
print -r -- "$0" >> "$MOLE_TEST_LOG"
print -r -- '\''#compdef mole mo
_mole() { :; }
compdef _mole mole mo'\''
' > "$fixture/bin dir/mole"
cp "$fixture/bin dir/mole" "$fixture/replacement bin/mole"
chmod +x "$fixture/bin dir/mole" "$fixture/replacement bin/mole"
touch -t 202001010000 "$fixture/bin dir/mole"

print -r -- '
emulate -L zsh
fixture=$1
znap_root=$2
mode=$3
export XDG_CACHE_HOME="$fixture/cache" XDG_CONFIG_HOME="$fixture/config"
export XDG_DATA_HOME="$fixture/data" XDG_STATE_HOME="$fixture/state"
zstyle :znap: repos-dir "$fixture/repos"
zstyle :znap: auto-compile no
mkdir -p "$fixture/repos"
source "$znap_root/znap.zsh" || exit 1
# Znap installs its own placeholder compdef. Exercise the absent case too.
unfunction compdef
case $mode in
  immediate) export PATH="$fixture/bin dir" ;;
  deferred) export PATH="$fixture/bin dir" ;;
  replacement) export PATH="$fixture/replacement bin" ;;
  missing) export PATH="$fixture/empty-bin" ;;
esac
rehash
fail() { print -u2 -r -- "FAIL: $mode: $*"; exit 1; }
typeset -A bindings=()
typeset -i binding_calls=0
install_compdef() {
  compdef() {
    local completer=$1 name
    shift
    for name in "$@"; do bindings[$name]=$completer; done
    (( ++binding_calls ))
  }
}
[[ $mode == immediate || $mode == replacement ]] && install_compdef
source "$fixture/startup.zsh" > "$fixture/stdout" 2> "$fixture/stderr"
[[ ! -s "$fixture/stderr" ]] || fail "startup wrote stderr: $(<"$fixture/stderr")"
if [[ $mode == missing ]]; then
  (( ! $+functions[_mole] && ! $+functions[_mole_compdef_once] )) || fail "registered missing executable"
  [[ ! -e "$XDG_CACHE_HOME/zsh-snap/eval/mole.zsh" ]] || fail "generated cache without executable"
  exit 0
fi
(( $+functions[_mole] )) || fail "completer not loaded"
if [[ $mode == deferred ]]; then
  (( ! $+functions[compdef] )) || fail "temporary compdef leaked"
  (( $+functions[_mole_compdef_once] )) || fail "retry hook missing"
  [[ ${precmd_functions[(r)_mole_compdef_once]} == _mole_compdef_once ]] || fail "retry hook not attached"
  _mole_compdef_once
  (( $+functions[_mole_compdef_once] && binding_calls == 0 )) || fail "retry retired before compinit"
  install_compdef
  _mole_compdef_once
  (( binding_calls == 1 )) || fail "deferred binding did not run once"
fi
[[ ${bindings[mole]-} == _mole && ${bindings[mo]-} == _mole ]] || fail "both names not bound"
(( ! $+functions[_mole_compdef_once] )) || fail "retry function not retired"
[[ -z ${precmd_functions[(r)_mole_compdef_once]} ]] || fail "retry hook not removed"
[[ -s "$XDG_CACHE_HOME/zsh-snap/eval/mole.zsh" ]] || fail "cache not written"
' > "$fixture/check.zsh"

count=0
check() {
  local label=$1 mode=$2 expected_generations=$3
  /bin/zsh -f "$fixture/check.zsh" "$fixture" "$znap_root" "$mode"
  local -a generations=()
  generations=("${(@f)$(<"$MOLE_TEST_LOG")}")
  generations=("${(@)generations:#}")
  [[ $#generations == $expected_generations ]] || {
    print -u2 -r -- "FAIL: $label (generations=$#generations expected=$expected_generations)"
    exit 1
  }
  (( ++count ))
  print -r -- "PASS: $label"
}

check 'missing executable skips generation and binding' missing 0
check 'cold startup generates and immediately binds mole and mo' immediate 1
check 'warm startup loads cache without generation' immediate 1
check 'warm startup defers both bindings until compdef exists' deferred 1
rm -f "$fixture/cache/zsh-snap/eval/mole.zsh"{,.zwc}
check 'cold startup defers both bindings without errors' deferred 2
check 'warm deferred startup still skips generation' deferred 2
touch -t 202101010000 "$fixture/bin dir/mole"
check 'executable mtime change invalidates cache' immediate 3
check 'updated executable has a warm cache' immediate 3
check 'resolved executable path change invalidates cache' replacement 4
check 'replacement executable has a warm cache' replacement 4
# The orphan guard must not fork ps and grep for command-only shells.
/bin/zsh -f -c '[[ ${+ZSH_EXECUTION_STRING} == 1 ]]' || { print -u2 -- 'FAIL: command shell execution marker'; exit 1; }
/bin/zsh -f -s <<< '[[ ${+ZSH_EXECUTION_STRING} == 0 ]]' || { print -u2 -- 'FAIL: stdin shell execution marker'; exit 1; }
(( ++count ))
print -r -- 'PASS: command-only shells expose the builtin execution marker'
print -r -- "$count tests passed."
