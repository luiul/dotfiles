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
