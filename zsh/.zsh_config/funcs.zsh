cht() {
	local query=$(echo "$@" | tr ' ' '+')
	curl cht.sh/$query
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
