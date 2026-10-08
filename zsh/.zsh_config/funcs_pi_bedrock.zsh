# Pi and AWS Bedrock model/region switching.
#
# grove (https://github.com/luiul/grove) discovers and probes models, stores
# the results, and projects them into models.json under the "grove" key. These
# helpers read that projection only; the grove store is the source of truth.
# The region map is independent of Pi's curated enabledModels scope.

typeset -g PI_MODELS_JSON="${PI_MODELS_JSON:-$HOME/dotfiles/pi/.pi/agent/models.json}"

_pi_bedrock_map_check() {
	if [[ ! -f "$PI_MODELS_JSON" ]]; then
		print -P "%F{red}✗%f $PI_MODELS_JSON not found"
		return 1
	fi
	command -v jq &>/dev/null || { print -P "%F{red}✗%f jq not found"; return 1 }
	if ! jq -e '.grove.bedrock' "$PI_MODELS_JSON" &>/dev/null; then
		print -P "%F{red}✗%f no grove key in $PI_MODELS_JSON. Run: grove sync"
		return 1
	fi
	return 0
}

# List every usable Bedrock model, optionally fuzzy-filtered.
# Usage: pi-models [pattern]
pi-models() {
	emulate -L zsh
	_pi_bedrock_map_check || return 1

	local pattern="${1:-}"
	local default_region
	default_region=$(jq -r '.grove.bedrock.defaultRegion' "$PI_MODELS_JSON")
	local current_region="${AWS_REGION:-$default_region}"

	local rows
	rows=$(jq -r '.grove.bedrock.regions | to_entries[] | "\(.value)\t\(.key)"' "$PI_MODELS_JSON" | sort)
	if [[ -n "$pattern" ]]; then
		rows=$(echo "$rows" | grep -i -- "$pattern")
	fi
	if [[ -z "$rows" ]]; then
		print -P "%F{yellow}⊘%f no models match '$pattern'"
		return 1
	fi

	local count
	count=$(echo "$rows" | wc -l | tr -d ' ')
	print -P "%F{cyan}$count%f model(s) -- current region: %F{cyan}$current_region%f (default: $default_region)"
	echo "$rows" | while IFS=$'\t' read -r region id; do
		if [[ "$region" == "$current_region" ]]; then
			print -P "  %F{green}●%f $id  %F{green}($region)%f"
		else
			print -P "  %F{240}○%f $id  %F{240}($region)%f"
		fi
	done
}

# Show or switch the AWS region pi's Bedrock provider invokes in.
# Usage: pi-region             # show current region + how many models usable there
#        pi-region <region>    # switch AWS_REGION for this shell
#        pi-region default     # reset to the default region (unset override)
pi-region() {
	emulate -L zsh
	_pi_bedrock_map_check || return 1

	local default_region
	default_region=$(jq -r '.grove.bedrock.defaultRegion' "$PI_MODELS_JSON")

	if [[ -z "${1:-}" ]]; then
		local current="${AWS_REGION:-$default_region}"
		local n
		n=$(jq --arg r "$current" -r '[.grove.bedrock.regions | to_entries[] | select(.value == $r)] | length' "$PI_MODELS_JSON")
		if [[ -n "${AWS_REGION:-}" ]]; then
			print -P "%F{cyan}$AWS_REGION%f (override active, default is $default_region) -- $n model(s) usable here. See: pi-models"
		else
			print -P "%F{cyan}$default_region%f (default, no override) -- $n model(s) usable here. See: pi-models"
		fi
		return 0
	fi

	if [[ "$1" == "default" || "$1" == "reset" ]]; then
		unset AWS_REGION
		print -P "%F{green}✓%f AWS_REGION override cleared -- back to default ($default_region)"
		return 0
	fi

	local known_regions
	known_regions=$(jq -r '.grove.bedrock.regions | to_entries[] | .value' "$PI_MODELS_JSON" | sort -u)
	if ! echo "$known_regions" | grep -qxF "$1"; then
		print -P "%F{red}✗%f '$1' has no probe-verified usable models. Known regions: $(echo "$known_regions" | tr '\n' ' ')"
		return 1
	fi

	export AWS_REGION="$1"
	local n
	n=$(jq --arg r "$1" -r '[.grove.bedrock.regions | to_entries[] | select(.value == $r)] | length' "$PI_MODELS_JSON")
	print -P "%F{green}✓%f AWS_REGION=$1 for this shell -- $n model(s) usable here. See: pi-models"
}

# Resolve a model id/pattern and launch pi with it. The region extension picks
# the working region from the same grove key at session start. Any extra args
# are passed straight through to pi (e.g. `-p "hi"` for a one-off).
# Usage: pi-use <model-id-or-pattern> [pi-args...]
pi-use() {
	emulate -L zsh
	_pi_bedrock_map_check || return 1

	if [[ -z "${1:-}" ]]; then
		print "Usage: pi-use <model-id-or-pattern> [pi-args...]   (run 'pi-models' to list ids)"
		return 1
	fi
	local pattern="$1"
	shift

	local resolved region
	# Exact id match first.
	region=$(jq -r --arg id "$pattern" '.grove.bedrock.regions[$id] // empty' "$PI_MODELS_JSON")
	if [[ -n "$region" ]]; then
		resolved="$pattern"
	else
		local matches
		matches=$(jq -r '.grove.bedrock.regions | keys[]' "$PI_MODELS_JSON" | grep -i -- "$pattern")
		local n
		n=$(echo "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
		if [[ "$n" -eq 0 ]]; then
			print -P "%F{red}✗%f no model matches '$pattern'. See: pi-models"
			return 1
		elif [[ "$n" -gt 1 ]]; then
			print -P "%F{yellow}⊘%f '$pattern' is ambiguous, matches:"
			echo "$matches" | sed 's/^/  /'
			print "Be more specific."
			return 1
		fi
		resolved="$matches"
		region=$(jq -r --arg id "$resolved" '.grove.bedrock.regions[$id]' "$PI_MODELS_JSON")
	fi

	print -P "%F{green}✓%f $resolved  %F{green}($region)%f"
	AWS_REGION="$region" pi --provider amazon-bedrock --model "$resolved" "$@"
}
