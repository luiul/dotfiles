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
