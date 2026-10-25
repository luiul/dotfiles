#!/bin/zsh -f
# Real Git paths, fake Orca calls. Never changes live Orca registrations.
emulate -L zsh
setopt errexit nounset pipefail

local_repo=${0:A:h:h}
source "$local_repo/zsh/.zsh_config/funcs_orca.zsh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/orca-watch.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$fixture/bin" "$fixture/not a repo" "$fixture/main repo/nested"
export TEST_LOG="$fixture/calls" TEST_REGISTERED="$fixture/registered"
export TEST_SCENARIO=existing

# Keep hooks, the real registry, and editor launch out of the fixture setup.
printf 'worktree-path = "%s/linked repo"\n' "$fixture" > "$fixture/wt.toml"
git init -q -b main "$fixture/main repo"
git -C "$fixture/main repo" -c user.name=Test -c user.email=test@example.invalid commit -q --allow-empty -m fixture
WORKTRUNK_AGENT=1 wt -C "$fixture/main repo" --config "$fixture/wt.toml" switch --create fixture --no-cd --yes --format json >/dev/null 2>&1
mkdir -p "$fixture/linked repo/nested"
main_root=$(git -C "$fixture/main repo" rev-parse --show-toplevel)

# Worktree metadata also handles checkouts with a separate Git directory.
git init -q -b main --separate-git-dir="$fixture/separate metadata" "$fixture/separate repo"
git -C "$fixture/separate repo" -c user.name=Test -c user.email=test@example.invalid commit -q --allow-empty -m fixture
separate_root=$(git -C "$fixture/separate repo" rev-parse --show-toplevel)
git init -q --bare "$fixture/bare repo"

printf '%s\n' '#!/bin/zsh -f
print -r -- "$2|$4|${5-}|${6-}|${7-}" >> "$TEST_LOG"
case "$2" in
  show)
    case "$TEST_SCENARIO" in
      missing|add-fails|add-false|set-fails|set-false)
        if [[ ! -f $TEST_REGISTERED ]]; then
          print -r -- '\''{"ok":false,"error":{"code":"repo_not_found"}}'\''
          exit 1
        fi ;;
      auth-error)
        print -r -- '\''{"ok":false,"error":{"code":"runtime_access_denied"}}'\''
        exit 1 ;;
      false-ok-exit)
        print -r -- '\''{"ok":false,"error":{"code":"runtime_access_denied"}}'\''
        exit 0 ;;
      bad-exit)
        print -r -- '\''{"ok":true}'\''
        exit 9 ;;
      invalid-json)
        print -r -- "not JSON"
        exit 0 ;;
      offline)
        print -u2 -- "Orca is not running."
        exit 1 ;;
    esac ;;
  add)
    case "$TEST_SCENARIO" in
      add-fails|add-false)
        print -r -- '\''{"ok":false,"error":{"code":"add_failed"}}'\''
        [[ $TEST_SCENARIO == add-false ]] && exit 0
        exit 1 ;;
    esac
    touch "$TEST_REGISTERED" ;;
  set)
    case "$TEST_SCENARIO" in
      set-fails|set-false)
        print -r -- '\''{"ok":false,"error":{"code":"set_failed"}}'\''
        [[ $TEST_SCENARIO == set-false ]] && exit 0
        exit 1 ;;
    esac ;;
  *) exit 2 ;;
esac
print -r -- '\''{"ok":true}'\''
' > "$fixture/bin/orca"
chmod +x "$fixture/bin/orca"
export PATH="$fixture/bin:$PATH"

count=0
check() {
  local label="$1" expected_root="$2" expected_calls="$3" cwd="$4"
  shift 4
  : > "$TEST_LOG"
  local output="" rc=0
  output=$(builtin cd -- "$cwd" && eval 'owa "$@"') || rc=$?
  (( rc == 0 )) || { print -u2 -- "FAIL: $label (exit $rc): $output"; exit 1; }
  [[ $output == "Orca is watching $expected_root (external worktrees: show)." ]] || { print -u2 -- "FAIL: $label output: $output"; exit 1; }
  local calls="$(<"$TEST_LOG")"
  [[ $calls == "$expected_calls" ]] || { print -u2 -- "FAIL: $label calls: $calls"; exit 1; }
  (( ++count ))
  print -r -- "PASS: $label"
}

failure() {
  local label="$1" scenario="$2" expected_calls="$3"
  shift 3
  TEST_SCENARIO="$scenario"
  rm -f -- "$TEST_REGISTERED"
  : > "$TEST_LOG"
  local output="" rc=0
  output=$(orca-watch "$@" 2>&1) || rc=$?
  (( rc != 0 )) || { print -u2 -- "FAIL: $label accepted failure"; exit 1; }
  [[ $output != *'Orca is watching'* ]] || { print -u2 -- "FAIL: $label false success: $output"; exit 1; }
  local calls="$(<"$TEST_LOG")"
  [[ $calls == "$expected_calls" ]] || { print -u2 -- "FAIL: $label calls: $calls"; exit 1; }
  [[ -n $output ]] || { print -u2 -- "FAIL: $label swallowed error"; exit 1; }
  (( ++count ))
  print -r -- "PASS: $label"
}

show="show|path:$main_root|--json||"
set_call="set|path:$main_root|--external-worktree-visibility|show|--json"
existing_calls="$show"$'\n'"$set_call"
add_calls="$show"$'\n'"add|$main_root|--json||"$'\n'"$set_call"

check 'absolute path from elsewhere, including spaces' "$main_root" "$existing_calls" / "$fixture/main repo"
check 'relative path' "$main_root" "$existing_calls" "$fixture" 'main repo'
original_home="$HOME"
export HOME="$fixture"
check 'quoted home-relative path' "$main_root" "$existing_calls" / '~/main repo'
export HOME="$original_home"
check 'no argument inside checkout' "$main_root" "$existing_calls" "$fixture/main repo"
check 'no argument inside subdirectory' "$main_root" "$existing_calls" "$fixture/main repo/nested"
check 'explicit linked worktree' "$main_root" "$existing_calls" / "$fixture/linked repo"
check 'no argument inside linked worktree subdirectory' "$main_root" "$existing_calls" "$fixture/linked repo/nested"
ln -s "$fixture/main repo" "$fixture/repo link"
check 'symlink to checkout' "$main_root" "$existing_calls" / "$fixture/repo link"
TEST_SCENARIO=missing
check 'register new repo, then show' "$main_root" "$add_calls" / "$fixture/main repo"
check 'repeat skips registration' "$main_root" "$existing_calls" / "$fixture/main repo"
TEST_SCENARIO=existing
check 'separate Git directory' "$separate_root" "show|path:$separate_root|--json||"$'\n'"set|path:$separate_root|--external-worktree-visibility|show|--json" / "$fixture/separate repo"

failure 'invalid path' existing '' "$fixture/absent"
failure 'non-repo directory' existing '' "$fixture/not a repo"
failure 'too many arguments' existing '' "$fixture/main repo" extra
failure 'bare repo rejected' existing '' "$fixture/bare repo"
for scenario in auth-error false-ok-exit bad-exit invalid-json offline; do
  failure "Orca show: $scenario" "$scenario" "$show" "$fixture/main repo"
done
for scenario in add-fails add-false; do
  failure "Orca add: $scenario" "$scenario" "$show"$'\n'"add|$main_root|--json||" "$fixture/main repo"
done
for scenario in set-fails set-false; do
  failure "Orca set: $scenario" "$scenario" "$add_calls" "$fixture/main repo"
  [[ -f $TEST_REGISTERED ]] || { print -u2 -- 'FAIL: expected registration to survive set failure'; exit 1; }
done

[[ ${aliases[owa]} == orca-watch ]] || { print -u2 -- 'FAIL: owa alias'; exit 1; }
TEST_SCENARIO=existing
saved_cwd="$PWD"
: > "$TEST_LOG"
orca-watch "$fixture/main repo" >/dev/null
[[ $PWD == $saved_cwd ]] || { print -u2 -- 'FAIL: changed the current directory'; exit 1; }
(( ++count ))
print -r -- 'PASS: current directory unchanged'
print -r -- "$count tests passed."
