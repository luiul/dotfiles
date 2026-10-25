#!/bin/zsh -f
# Measure helper cost separately from editor startup. Never opens VS Code.
emulate -L zsh
setopt errexit nounset pipefail
zmodload zsh/datetime

repo=${0:A:h:h}
source "$repo/zsh/.zsh_config/funcs.zsh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/bench-cod.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$fixture/bin" "$fixture/target dir"
# A real executable with no editor work. Same process launch cost for all cases.
ln -s /usr/bin/true "$fixture/bin/code"
export PATH="$fixture/bin:$PATH"
builtin cd -- "$fixture"

# Last removed implementation, from b9f96cc^:zsh/.zsh_config/funcs.zsh.
previous_cod() {
	local reuse=false tmp="${TMPDIR:-/tmp}/cod.$$.$RANDOM" rc err
	if [[ $1 == -r || $1 == --reuse-window ]]; then
		reuse=true
		shift
	fi
	cd "$@" 2>"$tmp"
	rc=$?
	err="$(<$tmp)"
	zf_rm -f -- "$tmp"
	if (( rc == 0 )) || [[ "$err" == *"already in the only match"* ]]; then
		if $reuse; then
			code -r .
		else
			code .
		fi
	else
		[[ -n "$err" ]] && print -r -- "$err" >&2
		return $rc
	fi
}

# No hooks or zoxide process costs: measure only the code changed here.
# Live verification covers the full interactive shell separately.
direct_current() { command code .; }
direct_path() { cd "$1" && command code .; }
old_current() { previous_cod .; }
old_path() { previous_cod "$1"; }

suite() {
	local -i iterations=$1 rounds=$2 round offset index
	local -a labels=('code . (baseline)' 'cod (current directory)' 'old helper (cd .)' 'cd PATH && code .' 'cod PATH' 'old helper PATH')
	local -a helpers=(direct_current cod old_current direct_path cod old_path)
	local -a args=() samples=()
	local -A results=()
	local -F start elapsed
	for (( index=1; index<=6; ++index )); do
		args=()
		(( index <= 3 )) || args=("$fixture/target dir")
		repeat 5 { "${helpers[index]}" "${args[@]}"; }
	done
	# Rotate case order each round to reduce bias from changing system load.
	for (( round=0; round<rounds; ++round )); do
		for (( offset=0; offset<6; ++offset )); do
			index=$(( (round + offset) % 6 + 1 ))
			args=()
			(( index <= 3 )) || args=("$fixture/target dir")
			start=$EPOCHREALTIME
			repeat "$iterations" { "${helpers[index]}" "${args[@]}"; }
			elapsed=$(( (EPOCHREALTIME - start) * 1000000 / iterations ))
			results[$index]+=" $elapsed"
		done
	done
	for (( index=1; index<=6; ++index )); do
		samples=( ${(on)${=results[$index]}} )
		printf '%-25s median %10.3f us/call  min %10.3f  max %10.3f\n' \
			"${labels[index]}" "${samples[$(( rounds / 2 + 1 ))]}" "${samples[1]}" "${samples[-1]}"
	done
}

print -r -- 'External no-op editor: 13 rotating batches of 40 calls (5 warmup calls each).'
suite 40 13

# Replace only editor dispatch in these benchmark-local function copies.
# No external processes remain; this exposes overhead hidden by process startup.
functions[cod]=${functions[cod]/command code ./:}
functions[previous_cod]=${functions[previous_cod]//code -r ./:}
functions[previous_cod]=${functions[previous_cod]//code ./:}
direct_current() { :; }
direct_path() { cd "$1" && :; }
print
print -r -- 'Shell-only isolation: editor dispatch replaced with : in local copies.'
print -r -- '13 rotating batches of 2000 calls (5 warmup calls each).'
suite 2000 13
