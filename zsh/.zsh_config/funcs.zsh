find-duplicate-filenames() {
	# Default values
	local root_dir="."
	local filter_dir_name_regex=""
	local show_help=0

	# Parse arguments
	for arg in "$@"; do
		case $arg in
		--help | -h)
			show_help=1
			;;
		--root=*)
			root_dir="${arg#*=}"
			;;
		--dir-name-regex=*)
			filter_dir_name_regex="${arg#*=}"
			;;
		*)
			echo "Unknown argument: $arg"
			echo "Use --help for usage information."
			return 1
			;;
		esac
	done

	# Show help if requested
	if [[ "$show_help" -eq 1 ]]; then
		echo "Usage: find-duplicate-filenames --root=DIR [--dir-name-regex=REGEX]"
		echo ""
		echo "Recursively find files with duplicate names (same basename) and list all their full paths."
		echo ""
		echo "Arguments:"
		echo "  --root=DIR               Root directory to start searching from. Defaults to current directory."
		echo "  --dir-name-regex=REGEX   (Optional) Only search inside subdirectories whose NAMES match this regex."
		echo "                           The regex is applied to the last part of the directory path (not full path)."
		echo "  --help                   Show this help message."
		echo ""
		echo "Examples:"
		echo "  find-duplicate-filenames --root=."
		echo "  find-duplicate-filenames --root=/projects --dir-name-regex='^ops'"
		echo "  find-duplicate-filenames --root=/data --dir-name-regex='log'"
		echo "  find-duplicate-filenames --root=/src --dir-name-regex='-data$'"
		return
	fi

	# Validate root directory
	if [[ ! -d "$root_dir" ]]; then
		echo "Error: Directory '$root_dir' not found."
		return 1
	fi

	# Find all file paths under matching directories
	if [[ -n "$filter_dir_name_regex" ]]; then
		find "$root_dir" -type d | grep -E "/[^/]*${filter_dir_name_regex}[^/]*$" | while read -r dir; do
			find "$dir" -type f
		done
	else
		find "$root_dir" -type f
	fi |
		awk -F/ '
        {
            filename = $NF
            files[filename] = files[filename] ? files[filename] ORS $0 : $0
            counts[filename]++
        }
        END {
            for (name in counts) {
                if (counts[name] > 1) {
                    print "Duplicate filename: " name
                    print files[name]
                    print ""
                }
            }
        }
    '
}

# Recursively activate a Python virtual environment up the directory tree
activate() {
	local current_dir
	current_dir=$(realpath "$(pwd)")

	while [ "$current_dir" != "/" ]; do
		for venv_dir in ".venv" "venv"; do
			local activate_path="$current_dir/$venv_dir/bin/activate"
			if [ -f "$activate_path" ]; then
				source "$activate_path"
				return 0
			fi
		done
		current_dir=$(dirname "$current_dir")
	done

	return 1
}

remove-pycache() {
	# Create a temporary file to hold the list of items to be deleted
	local tempfile=$(mktemp)

	# Find and log directories and files, then delete them
	find . \( -type d -name "__pycache__" -o -type f -name "*.pyc" \) -print | tee "$tempfile" | xargs rm -rf

	# Summarize the results
	local dir_count=$(grep -c '/__pycache__$' "$tempfile")
	local file_count=$(grep -c '\.pyc$' "$tempfile")

	echo "Removed __pycache__ directories: $dir_count"
	echo "Removed .pyc files: $file_count"
	echo "Details of removed items were logged to: $tempfile"

	# Display the contents of the log file (optional)
	echo "Do you want to review the deleted items log? (y/n)"
	read -r confirm
	if [[ "$confirm" == "y" ]]; then
		cat "$tempfile"
	fi

	# Cleanup: remove the log file
	echo "Cleaning up log file..."
	rm "$tempfile"
	echo "Log file removed and cleanup complete."
}

ffind() {
	if [ -z "$1" ]; then
		find . | fzf
	else
		cat "$1" | fzf
	fi
}

del() { # Move files to Trash instead of deleting them
	for file in "$@"; do
		local dest=~/.Trash/$(basename -- "$file")
		if [ -e "$dest" ]; then
			dest="${dest} $(date +%H-%M-%S)"
		fi
		mv -iv -- "$file" "$dest"
	done
}

cht() {
	local query=$(echo "$@" | tr ' ' '+')
	curl cht.sh/$query
}

replace-in-file() {
	local file=$1
	local search_string=$2
	local replace_string=$3

	if [[ -z $file || -z $search_string || -z $replace_string ]]; then
		echo "Usage: replace-in-file <file> <search_string> <replace_string>"
		echo "Example: replace-in-file ~/.zshrc \"/Users/luisaceituno\" \"\$HOME\""
		return 1
	fi

	if [[ -f $file ]]; then
		echo "You are about to replace all occurrences of '${search_string}' with '${replace_string}' in ${file}."
		echo "Do you want to proceed? (y/n)"
		read -r confirm

		if [[ $confirm == "y" || $confirm == "Y" ]]; then
			sed -i '' "s|${search_string}|${replace_string}|g" "$file" &&
				echo "Replaced all occurrences of '${search_string}' with '${replace_string}' in ${file}."
		else
			echo "Operation canceled."
		fi
	else
		echo "Error: File '${file}' not found."
		return 1
	fi
}

md-to-rtf() {
	# Check if the input file is provided
	if [ -z "$1" ]; then
		echo "Please provide the path to the markdown file."
		return 1
	fi

	# Get the full path of the markdown file
	local md_file="$1"

	# Extract the directory and filename without extension
	local dir=$(dirname "$md_file")
	local filename=$(basename "$md_file" .md)

	# Define the output RTF file path
	local rtf_file="${dir}/${filename}.rtf"

	# Check if the RTF file already exists and notify user
	if [ -f "$rtf_file" ]; then
		echo "RTF file ${rtf_file} already exists. It will be replaced."
	fi

	# Convert the markdown file to RTF using pandoc (overwrites if exists)
	pandoc -f markdown -s "$md_file" -o "$rtf_file"

	# Check if the conversion was successful
	if [ $? -ne 0 ]; then
		echo "Failed to convert markdown to RTF."
		return 1
	fi

	# Copy the contents of the RTF file to the clipboard
	cat "$rtf_file" | pbcopy

	# Confirm the action
	echo "RTF file created at ${rtf_file} and copied to clipboard."
}

upgrade-tools() {
	brew update
	brew upgrade
	uv tool upgrade --all
}

ldel() {
	emulate -L zsh

	if (($# < 1)); then
		print "Usage: ldel <pattern>"
		return 1
	fi

	local pattern="$1"
	local pattern_lc
	pattern_lc="$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')"

	local -a matches entries
	entries=(*(D)) # includes dotfiles; doesn't include . or ..

	local f f_lc
	for f in "${entries[@]}"; do
		f_lc="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
		case "$f_lc" in
		*"$pattern_lc"*) matches+=("$f") ;;
		esac
	done

	if ((${#matches} == 0)); then
		print "No matches for: $pattern"
		return 0
	fi

	print "Matches (${#matches}):"
	printf '  %s\n' "${matches[@]}"

	printf "Move ALL of these to Trash? (y/N): "
	local ans
	read -r ans
	if [[ $ans != [Yy] ]]; then
		print "Aborted."
		return 0
	fi

	mkdir -p ~/.Trash

	local m ok=0 fail=0
	for m in "${matches[@]}"; do
		if mv -iv -- "$m" ~/.Trash/; then
			((ok++))
		else
			((fail++))
		fi
	done

	print "Done. Moved: $ok  Failed: $fail"
}

# Start or reuse a single ssh-agent and add your key
ssh_agent_start() {
	local agent_env_file="$HOME/.ssh/agent_env"

	if [[ -f "$agent_env_file" ]]; then
		source "$agent_env_file" >/dev/null 2>&1

		if ssh-add -l >/dev/null 2>&1; then
			return 0
		fi

		rm -f "$agent_env_file"
		unset SSH_AUTH_SOCK SSH_AGENT_PID
	fi

	eval "$(ssh-agent -s)" >/dev/null

	ssh-add "$HOME/.ssh/id_ed25519" </dev/null

	{
		echo "export SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
		echo "export SSH_AGENT_PID=$SSH_AGENT_PID"
	} >|"$agent_env_file"
}

spellcheck() {
	local audience="team"
	local copy_variant="polished"
	local model="$ANTHROPIC_DEFAULT_HAIKU_MODEL"

	# Parse flags
	while getopts "a:c:m:h" opt; do
		case $opt in
		a) audience="$OPTARG" ;;
		c) copy_variant="$OPTARG" ;;
		m)
			case "$OPTARG" in
			haiku) model="$ANTHROPIC_DEFAULT_HAIKU_MODEL" ;;
			sonnet) model="$ANTHROPIC_DEFAULT_SONNET_MODEL" ;;
			opus) model="$ANTHROPIC_DEFAULT_OPUS_MODEL" ;;
			*) model="$OPTARG" ;;
			esac
			;;
		h)
			cat >&2 <<'EOF'
Usage: spellcheck [-a audience] [-c variant] [-m model] [-h] <message>
       echo "message" | spellcheck [-a audience] [-c variant] [-m model]

Flags:
  -a <audience>   Who you're writing to (default: team)
                  Options: team, leadership, cross-functional, external
  -c <variant>    Which variant to copy to clipboard (default: polished)
                  Options: casual, concise, polished, verbose
  -m <model>      Claude model (default: haiku)
                  Shortcuts: haiku, sonnet, opus
                  Or pass a full model ID directly
  -h              Print this help text
EOF
			return 0
			;;
		esac
	done
	shift $((OPTIND - 1))
	OPTIND=1

	# Validate audience
	case "$audience" in
	team | leadership | cross-functional | external) ;;
	*)
		echo "Invalid audience: $audience" >&2
		echo "Valid audiences: team, leadership, cross-functional, external" >&2
		return 1
		;;
	esac

	# Validate copy variant
	case "$copy_variant" in
	casual | concise | polished | verbose) ;;
	*)
		echo "Invalid variant: $copy_variant" >&2
		echo "Valid variants: casual, concise, polished, verbose" >&2
		return 1
		;;
	esac

	# Check dependencies
	if ! command -v claude &>/dev/null; then
		echo "Error: claude CLI not found" >&2
		return 1
	fi
	if ! command -v python3 &>/dev/null; then
		echo "Error: python3 not found" >&2
		return 1
	fi

	# Get message from args or stdin
	local message
	if (($# > 0)); then
		message="$*"
	else
		message=$(cat)
	fi

	if [[ -z "$message" ]]; then
		echo "Usage: spellcheck [-a audience] [-c variant] [-m model] [-h] <message>" >&2
		return 1
	fi

	local prompt
	read -r -d '' prompt <<'PROMPT'
You are a spell-checker for a senior data/analytics engineer striving for staff level.

Rules:
- Fix spelling, grammar, and light structural issues only
- Preserve the author's voice and writing style — do not rewrite or rephrase beyond what's necessary
- Verify data engineering and analytics terminology is used correctly (e.g., ETL vs ELT, data lakehouse, medallion architecture, SCD, idempotency, orchestration, lineage, observability, dbt, dimensional modeling, etc.)
- Flag or fix any technically inaccurate statements related to data pipelines, warehousing, transformation, modeling, or analytics engineering
- Ensure the language reflects the seniority and technical depth expected at a staff level

Audience tones:
- team: Casual-professional — Slack messages to your team
- leadership: Polished and concise — messages to managers/directors
- cross-functional: Clear, minimal jargon — stakeholders outside the team
- external: Formal — vendors, partners, or clients

Return a JSON object with exactly 4 keys: "casual", "concise", "polished", "verbose".
Each value is the corrected message in that tone variant.
- casual: Friendly, relaxed but correct
- concise: Shortest version that keeps the full meaning
- polished: Professional and well-structured
- verbose: Thorough, detailed, and formal

Output ONLY the raw JSON object — no explanations, no markdown fences, no preamble.
PROMPT

	# Suppress zsh job control messages for background spinner
	setopt LOCAL_OPTIONS NO_MONITOR

	# Loading spinner
	local spinner_pid
	(
		local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
		local i=0
		while true; do
			printf '\r  %s Checking with Claude...' "${frames[$((i % ${#frames[@]} + 1))]}" >&2
			i=$((i + 1))
			sleep 0.1
		done
	) &
	spinner_pid=$!

	trap "kill $spinner_pid 2>/dev/null; wait $spinner_pid 2>/dev/null" EXIT INT TERM

	local raw_result
	raw_result=$(echo "$message" | claude --model "$model" -p "$prompt

Audience: $audience

Correct the following message:")
	local exit_code=$?

	kill $spinner_pid 2>/dev/null
	wait $spinner_pid 2>/dev/null
	trap - EXIT INT TERM
	printf '\r\033[K' >&2

	if [[ $exit_code -ne 0 ]]; then
		echo "Error: claude command failed" >&2
		return 1
	fi

	# Strip markdown fences if present
	raw_result=$(echo "$raw_result" | sed 's/^```json//;s/^```//')

	# Parse JSON into shell variables
	local parsed
	parsed=$(python3 -c "
import json, sys, shlex
data = json.loads(sys.stdin.read())
for key in ('casual', 'concise', 'polished', 'verbose'):
    print(f'{key}={shlex.quote(data[key])}')
" <<<"$raw_result" 2>/dev/null)

	if [[ $? -ne 0 ]]; then
		echo "Error: failed to parse JSON response" >&2
		echo "Raw response:" >&2
		echo "$raw_result" >&2
		return 1
	fi

	eval "$parsed"

	# Display variants
	local bold=$(tput bold)
	local reset=$(tput sgr0)
	local green=$(tput setaf 2)
	local yellow=$(tput setaf 3)
	local cyan=$(tput setaf 6)
	local magenta=$(tput setaf 5)
	local dim=$(tput dim)
	local hr="${dim}$(printf '%.0s─' {1..60})${reset}"

	local copied_label=""

	for variant in casual concise polished verbose; do
		case $variant in
		casual) local color=$green ;;
		concise) local color=$yellow ;;
		polished) local color=$cyan ;;
		verbose) local color=$magenta ;;
		esac

		if [[ "$variant" == "$copy_variant" ]]; then
			copied_label=" ${dim}[copied]${reset}"
		else
			copied_label=""
		fi

		echo ""
		echo "${color}${bold}${variant:u}${reset}${copied_label}"
		echo "$hr"
		echo "${(P)variant}"
	done

	echo ""

	# Copy selected variant to clipboard
	local to_copy="${(P)copy_variant}"
	echo -n "$to_copy" | pbcopy
	echo "${dim}Copied ${bold}${copy_variant}${reset}${dim} variant to clipboard.${reset}"
}
