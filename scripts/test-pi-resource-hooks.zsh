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
: > "$CALL_LOG"
pi-extensions-upgrade >/dev/null
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 3 ]]
grep -q '^pi update --extensions$' "$CALL_LOG"
grep -q '^npm audit fix$' "$CALL_LOG"
grep -q '^node .*patch-context-mode.mjs --apply --package-dir ' "$CALL_LOG"
print 'PASS successful upgrade reapplies patch'
: > "$CALL_LOG"
export MOCK_PI_EXIT=2
if pi-extensions-upgrade >/dev/null; then print 'FAIL failed upgrade accepted'; exit 1; fi
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 1 ]]
print 'PASS failed update stops audit and patch'
unset MOCK_PI_EXIT
: > "$CALL_LOG"
export MOCK_NPM_EXIT=3
if pi-extensions-audit-fix >/dev/null; then print 'FAIL failed audit accepted'; exit 1; fi
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 1 ]]
print 'PASS failed audit stops patch'
unset MOCK_NPM_EXIT
: > "$CALL_LOG"
export MOCK_NODE_EXIT=4
if pi-extensions-audit-fix >/dev/null; then print 'FAIL failed patch accepted'; exit 1; fi
[[ $(wc -l < "$CALL_LOG" | tr -d ' ') == 2 ]]
print 'PASS patch failure remains visible'
print 'ALL PASS resource update hooks'
