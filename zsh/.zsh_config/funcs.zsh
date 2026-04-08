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

				local dim=$(tput dim)
				local bold=$(tput bold)
				local reset=$(tput sgr0)
				local green=$(tput setaf 2)
				local venv_path="$current_dir/$venv_dir"
				local py_version=$(python3 --version 2>/dev/null | awk '{print $2}')
				local pkg_count=$(pip list --format=freeze 2>/dev/null | wc -l | tr -d ' ')

				echo ""
				echo "${green}${bold}activated${reset} ${dim}${venv_path/$HOME/~}${reset}"
				echo "${dim}python ${reset}${bold}${py_version}${reset}  ${dim}packages ${reset}${bold}${pkg_count}${reset}"
				return 0
			fi
		done
		current_dir=$(dirname "$current_dir")
	done

	echo "No virtual environment found" >&2
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

cod() {
	cd "$@" 2> >(grep -v "already in the only match" >&2) && code .
}

# Start or reuse ssh-agent (once per reboot)
ssh_agent_init() {
	local agent_env_file="$HOME/.ssh/agent_env"

	if [[ -f "$agent_env_file" ]]; then
		source "$agent_env_file" >/dev/null 2>&1

		if ! ssh-add -l >/dev/null 2>&1; then
			rm -f "$agent_env_file"
			unset SSH_AUTH_SOCK SSH_AGENT_PID
		fi
	fi

	if [[ -z "$SSH_AUTH_SOCK" ]]; then
		eval "$(ssh-agent -s)" >/dev/null

		local key_file
		for key_file in "$HOME"/.ssh/id_{ed25519,ecdsa,rsa}; do
			[[ -f "$key_file" ]] && ssh-add "$key_file" </dev/null && break
		done

		{
			echo "export SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
			echo "export SSH_AGENT_PID=$SSH_AGENT_PID"
		} >|"$agent_env_file"
	fi
}
