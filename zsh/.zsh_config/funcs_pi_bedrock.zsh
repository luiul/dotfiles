# pi + AWS Bedrock model/region switching
#
# pi has no per-model region config (see pi/.pi/agent/bin/sync-enabled-models.sh
# for the full story): it always invokes Bedrock in whatever AWS_REGION is
# exported, or the sso-bedrock profile's configured region (eu-west-1) if
# unset. `enabledModels`/Ctrl+P only ever offers the subset usable in that one
# default region. Everything else (us./jp./au.-prefixed models, and any
# ON_DEMAND model only deployed to a non-default region) is invocable, but
# only after switching AWS_REGION first -- these functions do that lookup so
# you never have to hand-manage AWS_REGION or remember which region a model
# needs.
#
# Data source: pi/.pi/agent/bedrock-models.json, a { modelId: region } map of
# every probe-verified-usable model across all regions scanned by
# sync-enabled-models.sh. Regenerate it by re-running that script.

typeset -g PI_BEDROCK_MODELS_JSON="${PI_BEDROCK_MODELS_JSON:-$HOME/dotfiles/pi/.pi/agent/bedrock-models.json}"

_pi_bedrock_map_check() {
	if [[ ! -f "$PI_BEDROCK_MODELS_JSON" ]]; then
		print -P "%F{red}✗%f $PI_BEDROCK_MODELS_JSON not found. Run: sync-enabled-models.sh"
		return 1
	fi
	command -v jq &>/dev/null || { print -P "%F{red}✗%f jq not found"; return 1 }
	return 0
}

# List every usable Bedrock model, optionally fuzzy-filtered.
# Usage: pi-models [pattern]
pi-models() {
	emulate -L zsh
	_pi_bedrock_map_check || return 1

	local pattern="${1:-}"
	local default_region
	default_region=$(jq -r '.defaultRegion' "$PI_BEDROCK_MODELS_JSON")
	local current_region="${AWS_REGION:-$default_region}"

	local rows
	rows=$(jq -r '.models | to_entries[] | "\(.value)\t\(.key)"' "$PI_BEDROCK_MODELS_JSON" | sort)
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
	default_region=$(jq -r '.defaultRegion' "$PI_BEDROCK_MODELS_JSON")

	if [[ -z "${1:-}" ]]; then
		local current="${AWS_REGION:-$default_region}"
		local n
		n=$(jq --arg r "$current" -r '.models | to_entries | map(select(.value == $r)) | length' "$PI_BEDROCK_MODELS_JSON")
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
	known_regions=$(jq -r '.models | to_entries[] | .value' "$PI_BEDROCK_MODELS_JSON" | sort -u)
	if ! echo "$known_regions" | grep -qxF "$1"; then
		print -P "%F{red}✗%f '$1' has no probe-verified usable models. Known regions: $(echo "$known_regions" | tr '\n' ' ')"
		return 1
	fi

	export AWS_REGION="$1"
	local n
	n=$(jq --arg r "$1" -r '.models | to_entries | map(select(.value == $r)) | length' "$PI_BEDROCK_MODELS_JSON")
	print -P "%F{green}✓%f AWS_REGION=$1 for this shell -- $n model(s) usable here. See: pi-models"
}

# Resolve a model id/pattern, switch AWS_REGION to wherever it actually lives,
# and launch pi with it. Any extra args are passed straight through to pi
# (e.g. `-p "hi"` for a one-off, or nothing for an interactive session).
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
	region=$(jq -r --arg id "$pattern" '.models[$id] // empty' "$PI_BEDROCK_MODELS_JSON")
	if [[ -n "$region" ]]; then
		resolved="$pattern"
	else
		local matches
		matches=$(jq -r '.models | keys[]' "$PI_BEDROCK_MODELS_JSON" | grep -i -- "$pattern")
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
		region=$(jq -r --arg id "$resolved" '.models[$id]' "$PI_BEDROCK_MODELS_JSON")
	fi

	print -P "%F{green}✓%f $resolved  %F{green}($region)%f"
	AWS_REGION="$region" pi --provider amazon-bedrock --model "$resolved" "$@"
}
