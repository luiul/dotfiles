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
	# Everything lives in a try/always block so cleanup (below) is guaranteed
	# to run even if the try-list is aborted abnormally (e.g. by an untrapped
	# signal) -- see zshmisc(1), "{ list } always { list }". Without this,
	# aborting mid-run could leave the TRAPINT override and helper functions
	# defined globally for the rest of the shell session (Ctrl+C would then
	# stay silently swallowed everywhere, not just inside this function).
	{
		# A deleted cwd (removed worktree, rmdir'd dir) makes brew/uv/npm die
		# on startup with "getcwd: cannot access parent directories" / ENOENT
		# process.cwd, because every tool stats its working directory first.
		# Jump to $HOME before anything runs; cd to an absolute path works even
		# when the current directory is gone.
		[[ -d $PWD ]] || cd -q -- "$HOME"

		# TRAPINT returning 0 swallows Ctrl+C so only the current step dies and
		# the next step runs. Use Ctrl+\ (SIGQUIT) to abort the whole function.
		TRAPINT() { return 0; }

		_report() {
			case $2 in
			0) print -P "  %F{green}✓%f $1 up to date" ;;
			130) print -P "  %F{yellow}⚠%f $1 interrupted" ;;
			*) print -P "  %F{red}✗%f $1 failed (exit $2)" ;;
			esac
		}
		_run() {
			local label=$1 tool=$2
			shift 2
			print -P "\n%F{blue}==>%f $label"
			# "command" bypasses any shell function/alias named after the tool,
			# so a shadowed "npm"/"brew" etc. can't hijack these privileged
			# upgrade calls.
			if ! command -v "$tool" &>/dev/null; then
				print -P "  %F{yellow}⊘%f $tool not installed (skipped)"
				return
			fi
			command "$@"
			_report "$label" $?
		}
		_preview() {
			local label=$1 tool=$2
			shift 2
			print -P "\n%F{blue}==>%f $label"
			if ! command -v "$tool" &>/dev/null; then
				print -P "  %F{yellow}⊘%f $tool not installed"
				return
			fi
			if (($# == 0)); then
				print -P "  %F{yellow}⊘%f no preview available"
				return
			fi
			local out
			out=$(command "$@" 2>/dev/null)
			[[ -n "$out" ]] && print -r -- "$out" | sed 's/^/  /' || print -P "  %F{green}✓%f up to date"
		}

		if [[ $1 == --check || $1 == -c ]]; then
			command -v brew &>/dev/null && command brew update >/dev/null 2>&1
			_preview "Homebrew"            brew   brew outdated
			_preview "uv tools"            uv
			_preview "npm global packages" npm    npm outdated -g
			return
		fi

		_run "Homebrew" brew sh -c 'command brew update && command brew upgrade && command brew cleanup'
		_run "uv tools" uv uv tool upgrade --all
		_run "npm global packages" npm npm update -g
	} always {
		unfunction _run _report _preview TRAPINT 2>/dev/null
	}
}

# cod: change directory with the configured cd, then open VS Code.
# With no arguments, skip cd and its hooks and open the current directory.
cod() {
	if (( $# )); then
		cd "$@" || return
	fi
	command code .
}

# piw: same directory rules as cod, then start Pi in a new Ghostty window.
# Use the running app when possible. open -na would create a second instance.
# Load the shell environment and discard buffered input before starting Pi.
piw() {
	if (( $# )); then
		cd "$@" || return
	fi
	local boot='echo starting pi...; stty -icanon -echo min 0 time 0 2>/dev/null; while read -k1 -t 0.2 _; do while read -k1 -t 1 _; do :; done; done; exec pi'
	if [[ "$(osascript -e 'tell application "System Events" to (exists process "ghostty")')" == true ]]; then
		if ! osascript - "$PWD" "$boot" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
	tell application "Ghostty"
		activate
		new window with configuration {initial working directory:(item 1 of argv), command:("/bin/zsh -ic " & quoted form of (item 2 of argv))}
	end tell
end run
APPLESCRIPT
		then
			print -u2 "piw: Ghostty is running but no window could be created in it."
			return 1
		fi
	else
		open -a Ghostty.app --args --window-save-state=never \
			--working-directory="$PWD" -e /bin/zsh -ic "$boot"
	fi
}

