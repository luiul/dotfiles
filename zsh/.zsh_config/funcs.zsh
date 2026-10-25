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

# Loaded once, imports only zf_rm (not a global rm override) so temp-file
# cleanup in piw() below doesn't fork an external rm process.
zmodload -F zsh/files b:zf_rm 2>/dev/null

# piw: open a new Ghostty window running pi, wherever `cd <args>` lands.
# Terminal alternative to cod (pi instead of VS Code).
#
# `cd "$@"` (no `--`, current shell) goes through the zoxide-backed `cd`
# wrapper, so `piw dot` resolves like `cd dot` does and the dir change
# persists in the calling shell, exactly as cod behaved. With no argument,
# `cd .` keeps the current directory: bare `cd` would jump to $HOME.
# zoxide returns
# non-zero with "you are already in the only match" when cwd is already the
# best match; that's success here (open pi in $PWD). No `--`: zoxide treats
# it as part of the query and resolution breaks.
#
# The new window MUST land in the ONE running Ghostty instance. The old
# `open -na` spawned a second Ghostty process per call, which broke the
# Switch window switcher (one app, two processes: windows split between
# them) and super+c (cc.sh finds the command center via `tell application
# "Ghostty"`, which resolves to only one of the running instances; from the
# other one the cc window looks missing and cc.sh opens an unclaimed home
# window as a duplicate). Ghostty 1.3's AppleScript dictionary opens windows
# in the running instance instead: `new window with configuration` accepts
# `initial working directory` and `command`. Only when Ghostty is not
# running at all does `open -a` (never `-n`: that flag is what spawned the
# extra instances) start the single instance; `--args` are dropped by an
# already-running app, hence the running check first.
# `--window-save-state=never` stops macOS resume from re-opening the previous
# saved session in the new instance. Config keys must come before `-e`, because
# `-e` consumes all remaining arguments. The `zsh -ic` wrapper loads .zshrc
# first so pi inherits the same env as a normal terminal (direnv, hooks).
#
# Input drain: the window is blank for several seconds (zsh boot, then pi's
# own extension/TUI boot), and pi's TUI SUBMITS whatever keystrokes were
# buffered in the pty during that time the moment it comes up. Keys the user
# types into the invisible window (probe keys, or keystrokes that land here
# because `activate` moved focus right as they were typing elsewhere) used
# to reach the agent as a submitted prompt, e.g. a stray "pi". So the wrapper
# echoes "starting pi..." immediately (the window is visibly alive), switches
# the pty to non-canonical no-echo, and drains input: exec pi only after a
# 0.2s silence probe followed by 1s of quiet. Keys typed before the TUI is
# up are discarded instead of submitted; pasting a prompt during boot is
# also discarded, wait for the TUI before typing or pasting.
# No --title: the title pipeline (title.zsh hook, then the session-title pi
# extension) owns the window title, and mycelium matches windows by that
# title grammar.
piw() {
	local tmp="${TMPDIR:-/tmp}/piw.$$.$RANDOM" rc err
	(( $# )) || set -- .
	cd "$@" 2>"$tmp"
	rc=$?
	err="$(<$tmp)"
	zf_rm -f -- "$tmp"
	if (( rc == 0 )) || [[ "$err" == *"already in the only match"* ]]; then
		if [[ "$(osascript -e 'tell application "System Events" to (exists process "ghostty")')" == true ]]; then
			if ! osascript - "$PWD" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
	tell application "Ghostty"
		activate
		new window with configuration {initial working directory:(item 1 of argv), command:"/bin/zsh -ic 'echo starting pi...; stty -icanon -echo min 0 time 0 2>/dev/null; while read -k1 -t 0.2 _; do while read -k1 -t 1 _; do :; done; done; exec pi'"}
	end tell
end run
APPLESCRIPT
			then
				print -u2 "piw: Ghostty is running but no window could be created in it."
				return 1
			fi
		else
			open -a Ghostty.app --args --window-save-state=never \
				--working-directory="$PWD" -e /bin/zsh -ic 'echo starting pi...; stty -icanon -echo min 0 time 0 2>/dev/null; while read -k1 -t 0.2 _; do while read -k1 -t 1 _; do :; done; done; exec pi'
		fi
	else
		[[ -n "$err" ]] && print -r -- "$err" >&2
		return $rc
	fi
}

