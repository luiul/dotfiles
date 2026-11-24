#!/bin/zsh -f
# Test update hooks with fake commands. Never update installed packages.
emulate -L zsh
setopt errexit nounset
root=${0:A:h:h}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/npm"
touch "$work/npm/package-lock.json"
export PI_NPM_DIR="$work/npm" CALL_LOG="$work/calls"
for name in pi npm node; do
	printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "$CALL_LOG"\nexit "${MOCK_%s_EXIT:-0}"\n' "$name" "${name:u}" > "$work/bin/$name"
	chmod 700 "$work/bin/$name"
done
export PATH="$work/bin:$PATH"
source "$root/zsh/.zsh_config/funcs_pi_npm.zsh"
check_calls() {
	local expected="$1"
	[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == "$expected" ]]
	grep -q '^node .*patch-context-mode.mjs --apply --package-dir ' "$CALL_LOG"
	grep -q '^node .*patch-context-mode.mjs --check --package-dir ' "$CALL_LOG"
}
: > "$CALL_LOG"
pi-extensions-upgrade >/dev/null
check_calls 4
grep -q '^pi update --extensions$' "$CALL_LOG"
grep -q '^npm audit fix$' "$CALL_LOG"
print 'PASS successful upgrade restores and verifies patch'
: > "$CALL_LOG"
export MOCK_PI_EXIT=2
local result=0
pi-extensions-upgrade >/dev/null 2>&1 || result=$?
[[ "$result" == 2 ]]
check_calls 3
! grep -q '^npm ' "$CALL_LOG"
print 'PASS failed partial update restores patch and preserves update failure'
unset MOCK_PI_EXIT
: > "$CALL_LOG"
export MOCK_NPM_EXIT=3
result=0
pi-extensions-audit-fix >/dev/null 2>&1 || result=$?
[[ "$result" == 3 ]]
check_calls 3
print 'PASS failed audit restores patch and preserves audit failure'
: > "$CALL_LOG"
export MOCK_NODE_EXIT=4
result=0
pi-extensions-audit-fix >/dev/null 2>&1 || result=$?
[[ "$result" == 3 ]]
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 2 ]]
print 'PASS both failures preserve original failure and attempt restoration'
unset MOCK_NPM_EXIT
: > "$CALL_LOG"
result=0
pi-extensions-audit-fix >/dev/null 2>&1 || result=$?
[[ "$result" == 4 ]]
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 2 ]]
print 'PASS patch failure blocks success'
unset MOCK_NODE_EXIT
# A check failure must also block success, even after apply succeeded.
printf '#!/bin/sh\nprintf "node %%s\\n" "$*" >> "$CALL_LOG"\ncase "$*" in *--check*) exit 5;; esac\n' > "$work/bin/node"
: > "$CALL_LOG"
result=0
pi-extensions-upgrade >/dev/null 2>&1 || result=$?
[[ "$result" == 5 ]]
check_calls 4
print 'PASS verification failure blocks success'
print 'ALL PASS resource update hooks'
