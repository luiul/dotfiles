#!/bin/zsh -f
# Compare both wrappers with HEAD, direct dispatch, and isolated shell work.
# No windows open. --app-check adds read-only queries of real app state.
emulate -L zsh
setopt errexit nounset pipefail
zmodload zsh/datetime

repo=${0:A:h:h}
source =(command git -C "$repo" show HEAD:zsh/.zsh_config/funcs.zsh)
functions[baseline_cod]=$functions[cod]
functions[baseline_piw]=$functions[piw]
# Also preserve the backend if this benchmark runs after the refactor is committed.
(( ! $+functions[_piw_launch] )) || functions[baseline_piw]=${functions[baseline_piw]/_piw_launch/_baseline_piw_launch}
(( ! $+functions[_piw_launch] )) || functions[_baseline_piw_launch]=$functions[_piw_launch]
source "$repo/zsh/.zsh_config/funcs.zsh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/bench-launch-helpers.XXXXXX")
trap 'command rm -rf -- "$fixture"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$fixture/bin" "$fixture/target dir"
ln -s /usr/bin/true "$fixture/bin/code"
ln -s /usr/bin/true "$fixture/bin/open"
printf '%s\n' '#!/bin/zsh -f
if [[ $1 == -e ]]; then print -r -- "$BENCH_RUNNING"; fi
' > "$fixture/bin/osascript"
chmod +x "$fixture/bin/osascript"
export PATH="$fixture/bin:$PATH" BENCH_RUNNING=true
builtin cd -- "$fixture/target dir"
cd() { builtin cd "$@"; }

# A direct backend is the lower bound for each wrapper's directory work.
direct_code() { command code .; }
direct_piw() { _piw_launch; }
local -a labels=(direct-code HEAD-cod cod cod-PATH direct-piw HEAD-piw piw piw-PATH)
local -a helpers=(direct_code baseline_cod cod cod direct_piw baseline_piw piw piw)

suite() {
	local -i iterations=$1 rounds=$2 round offset index
	local -a args=() samples=()
	local -A results=()
	local -F start elapsed
	for (( index=1; index<=${#helpers}; ++index )); do
		args=()
		(( index != 4 && index != 8 )) || args=("$fixture/target dir")
		repeat 3 { "${helpers[index]}" "${args[@]}"; }
	done
	for (( round=0; round<rounds; ++round )); do
		for (( offset=0; offset<${#helpers}; ++offset )); do
			index=$(( (round + offset) % ${#helpers} + 1 ))
			args=()
			(( index != 4 && index != 8 )) || args=("$fixture/target dir")
			start=$EPOCHREALTIME
			repeat "$iterations" { "${helpers[index]}" "${args[@]}"; }
			elapsed=$(( (EPOCHREALTIME - start) * 1000000 / iterations ))
			results[$index]+=" $elapsed"
		done
	done
	for (( index=1; index<=${#helpers}; ++index )); do
		samples=( ${(on)${=results[$index]}} )
		printf '%-16s median %10.3f us/call  min %10.3f  max %10.3f\n' \
			"${labels[index]}" "${samples[$(( rounds / 2 + 1 ))]}" "${samples[1]}" "${samples[-1]}"
	done
}

print -r -- "Baseline: $(command git -C "$repo" rev-parse --short HEAD)"
print -r -- 'No-op external launchers, running app: 7 rotating batches of 10 calls.'
suite 10 7
BENCH_RUNNING=false
print -r -- 'No-op external launchers, cold app: 7 rotating batches of 10 calls.'
suite 10 7

# Benchmark-local copies only. No production functions or files are replaced.
functions[cod]=${functions[cod]/command code ./:}
functions[baseline_cod]=${functions[baseline_cod]/command code ./:}
functions[_piw_launch]=${functions[_piw_launch]/open -a Ghostty.app/:}
functions[baseline_piw]=${functions[baseline_piw]/open -a Ghostty.app/:}
(( ! $+functions[_baseline_piw_launch] )) || functions[_baseline_piw_launch]=${functions[_baseline_piw_launch]/open -a Ghostty.app/:}
osascript() { if [[ $1 == -e ]]; then print -r -- "$BENCH_RUNNING"; fi; }
direct_code() { :; }
print -r -- 'Backend shell isolation, cold app: 9 rotating batches of 1000 calls.'
print -r -- 'No external executables, but app-check command substitution still forks.'
suite 1000 9

# Remove the whole backend to isolate only wrapper and directory overhead.
functions[_piw_launch]=':'
if (( $+functions[_baseline_piw_launch] )); then
	functions[_baseline_piw_launch]=':'
else
	functions[baseline_piw]="${functions[baseline_piw]%%local boot*} :"
fi
print -r -- 'Wrapper-only isolation: 9 rotating batches of 2000 calls. No process launches.'
suite 2000 9

if [[ ${1:-} == --app-check ]]; then
	# Absolute path bypasses the fixture. Both queries are read-only.
	local -a queries=('tell application "System Events" to (exists process "ghostty")' 'application "Ghostty" is running')
	local -a names=(HEAD-app-check direct-app-check) values=()
	local -A times=()
	local -F start elapsed
	local -i round index offset
	for (( round=0; round<9; ++round )); do
		for (( offset=0; offset<2; ++offset )); do
			index=$(( (round + offset) % 2 + 1 ))
			start=$EPOCHREALTIME
			command /usr/bin/osascript -e "$queries[index]" >/dev/null
			elapsed=$(( (EPOCHREALTIME - start) * 1000 ))
			times[$index]+=" $elapsed"
		done
	done
	print -r -- 'Real app checks: 9 rotating samples, including osascript startup.'
	for (( index=1; index<=2; ++index )); do
		values=( ${(on)${=times[$index]}} )
		printf '%-18s median %8.3f ms  min %8.3f  max %8.3f\n' "$names[index]" "$values[5]" "$values[1]" "$values[-1]"
	done
fi
