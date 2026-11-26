#!/bin/zsh -f
# Check the parent-shell handoff without touching a terminal server.
set -eu
root=${0:A:h:h}
fixture=$(mktemp -d)
trap 'command rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/main"
source "$root/zsh/.zsh_config/funcs_rex.zsh"
REX_SESSION=session:fixture
REX_BLOCK=block:fixture
fixture_checkout="$fixture/checkout"
closed=
result=0
remove_checkout=1
_wt_rex_checkout() { print -r -- "$fixture_checkout"; }
_wt_rex_close_removed_tab() { closed=$1; return 1; }
# The test shell is not interactive. Replace only the gate in the wrapper body.
coppice() {
  if (( remove_checkout )); then command rmdir -- "$fixture_checkout"; fi
  return $result
}
mkdir -p "$fixture/bin"
print -rl -- '#!/bin/sh' "printf 'worktree %s\n\n' '$fixture/main'" > "$fixture/bin/git"
chmod +x "$fixture/bin/git"
PATH="$fixture/bin:$PATH"
_wt_rex_wrap_coppice
functions[coppice]=${functions[coppice]//\&\& -o interactive \&\& -t 0 \&\& -t 1 /}

for scenario in success failure partial-failure unrelated; do
  mkdir -p "$fixture_checkout"
  builtin cd -- "$fixture_checkout"
  closed=
  result=0
  remove_checkout=1
  case $scenario in
    failure) result=1; remove_checkout=0 ;;
    partial-failure) result=1 ;;
    unrelated) remove_checkout=0 ;;
  esac
  actual=0
  coppice remove fixture 2>/dev/null || actual=$?
  [[ $actual == $result ]] || { print -u2 'Command status changed'; exit 1; }
  if (( remove_checkout )); then
    [[ $PWD == "$fixture/main" ]] || { print -u2 'Removed caller did not enter main'; exit 1; }
  else
    [[ $PWD == "$fixture_checkout" ]] || { print -u2 'Preserved caller moved'; exit 1; }
  fi
  if [[ $scenario == success ]]; then
    [[ $closed == "$fixture_checkout" ]] || { print -u2 'Successful caller did not close'; exit 1; }
  else
    [[ -z $closed ]] || { print -u2 'Unsuccessful or unrelated caller closed'; exit 1; }
  fi
  builtin cd -- "$fixture/main"
  [[ ! -d $fixture_checkout ]] || command rmdir -- "$fixture_checkout"
  print -r -- "PASS: Coppice shell handoff $scenario"
done
# Sourcing the wrapper twice must keep its original function, not recurse.
original=$functions[_wt_coppice_shell_orig]
_wt_rex_wrap_coppice
[[ $functions[_wt_coppice_shell_orig] == "$original" ]]
print -r -- 'PASS: repeated wrapper setup preserves the original function'
# Shell init replaces coppice() before dotfiles applies its wrapper again.
functions[coppice]=$original
_wt_rex_wrap_coppice
[[ $functions[coppice] == *'_wt_coppice_shell_orig "$@"'* ]]
[[ $functions[_wt_coppice_shell_orig] == "$original" ]]
print -r -- 'PASS: shell reinitialization restores the wrapper without recursion'
