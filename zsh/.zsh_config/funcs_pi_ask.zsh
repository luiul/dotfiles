# Ask pi about shell commands, mimicking VS Code's terminal Cmd+I.
# Ghostty maps Cmd+I to ^G (0x07), bound to pi-ask-widget below.
# Flow: type or accept a question -> pi + ai-model-router/gpt-5.6-luna answers
# -> the suggestion is printed, then you pick: run it, insert it, or close.
# Also available as a plain command: ask <question>

: ${PI_ASK_MODEL:=ai-model-router/gpt-5.6-luna}

_PI_ASK_SYSTEM='You are a zsh command-line assistant in a macOS terminal. Strict output format: line 1 = the single best command, plain text, no backticks, no leading $. Then a blank line. Then a compact markdown answer: at most 2 alternative commands in fenced code blocks, each with a one-line explanation. Max 12 lines total. No filler. Add one WARNING line only for destructive commands (rm, dd, mkfs).'

# Run pi and print its raw answer for question $1 (stdout = answer only).
_pi_ask_fetch() {
	emulate -L zsh
	pi --offline --model "$PI_ASK_MODEL" \
		--no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
		--no-session --thinking off \
		--system-prompt "$_PI_ASK_SYSTEM" \
		-p -- "$1" 2>/dev/null
}

# Fetch the answer for $1 into file $2, showing a spinner while waiting.
_pi_ask_fetch_spinner() {
	emulate -L zsh
	setopt no_notify no_monitor

	local question=$1
	local tmpfile=$2
	_pi_ask_fetch "$question" >| "$tmpfile" &!
	local pid=$!

	if zmodload zsh/zselect 2>/dev/null; then
		local -a frames=( '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏' )
		local i=1
		while kill -0 "$pid" 2>/dev/null; do
			print -Pn "\r\e[2m  ${frames[$i]} asking luna...\e[0m"
			i=$(( i % ${#frames[@]} + 1 ))
			zselect -t 8
		done
		print -P "\r\033[K"
	else
		print -P '\e[2m  asking luna...\e[0m'
		wait "$pid"
		print -P "\r\033[K"
	fi
}

# Strip ANSI color sequences from $1, print the result.
_pi_ask_strip_ansi() {
	print -r -- "$1" | command sed $'s/\x1b\\[[0-9;]*m//g'
}

# Extract the command (line 1) and the explanation (the rest) from $1.
# Sets the globals _PI_ASK_CMD and _PI_ASK_REST.
_pi_ask_split() {
	emulate -L zsh
	local answer=$1
	_PI_ASK_CMD=${answer%%$'\n'*}
	_PI_ASK_CMD="${_PI_ASK_CMD#"${_PI_ASK_CMD%%[![:space:]]*}"}"
	_PI_ASK_CMD="${_PI_ASK_CMD%"${_PI_ASK_CMD##*[![:space:]]}"}"
	_PI_ASK_REST=''
	[[ $answer == *$'\n'* ]] && _PI_ASK_REST=${answer#*$'\n'}
}

pi-ask-widget() {
	emulate -L zsh
	setopt no_notify no_monitor

	# Guard against re-entry (Cmd+I inside the question editor).
	[[ -n $_PI_ASK_NESTED ]] && return 1

	local original=$BUFFER

	# Suspend zsh-syntax-highlighting and zsh-autocomplete while the nested
	# editor is open: their region highlights and completion menus corrupt
	# the redraw of the printed question and answer.
	local -a suspended=()
	if (( $+functions[_zsh_highlight__zle-line-pre-redraw] )); then
		add-zle-hook-widget -d zle-line-pre-redraw _zsh_highlight__zle-line-pre-redraw 2>/dev/null
		add-zle-hook-widget -d zle-line-finish _zsh_highlight__zle-line-finish 2>/dev/null
		suspended+=(highlight)
	fi
	region_highlight=()
	if (( $+functions[.autocomplete:async:complete] )); then
		add-zle-hook-widget -d line-pre-redraw .autocomplete:async:complete 2>/dev/null
		suspended+=(autocomplete)
	fi

	# Nested line editor = the "Ask about commands" input box.
	# Prefilled with the current buffer; Enter submits, Ctrl+C cancels.
	zle -I
	[[ -z ${original//[[:space:]]/} ]] && print -P '%F{245}ask about commands (Enter to ask, Ctrl+C to cancel):%f'
	local rc
	{
		_PI_ASK_NESTED=1
		zle recursive-edit
		rc=$?
	} always {
		_PI_ASK_NESTED=''
		if (( ${suspended[(I)highlight]} )); then
			add-zle-hook-widget zle-line-pre-redraw _zsh_highlight__zle-line-pre-redraw 2>/dev/null
			add-zle-hook-widget zle-line-finish _zsh_highlight__zle-line-finish 2>/dev/null
		fi
		if (( ${suspended[(I)autocomplete]} )); then
			add-zle-hook-widget line-pre-redraw .autocomplete:async:complete 2>/dev/null
		fi
	}

	local question=$BUFFER
	if [[ $rc -ne 0 || -z ${question//[[:space:]]/} ]]; then
		BUFFER=$original
		CURSOR=${#BUFFER}
		zle redisplay
		return 1
	fi

	local tmpfile=${TMPDIR:-/tmp}/pi-ask.$$.out
	_pi_ask_fetch_spinner "$question" "$tmpfile"

	local answer
	answer=$(_pi_ask_strip_ansi "$(<"$tmpfile")")
	command rm -f "$tmpfile"

	if [[ -z ${answer//[[:space:]]/} ]]; then
		print -P '%F{red}pi-ask: no answer (check AI_MODEL_ROUTER_API_KEY / network)%f'
		BUFFER=$original
		CURSOR=${#BUFFER}
		zle redisplay
		return 1
	fi

	_pi_ask_split "$answer"
	print -Pn '%F{245}?%f '
	print -r -- "$question"
	print -r -- "$_PI_ASK_REST"
	print

	# VS Code-style chooser: show the suggestion, then let the user pick.
	print -Pn '%F{245}⏎ run first · i insert first · esc close%f '
	local key=''
	read -k1 -s key
	print -P '\r\033[K'
	case $key in
		($'\r'|$'\n')
			BUFFER=$_PI_ASK_CMD
			CURSOR=${#BUFFER}
			zle accept-line
			;;
		(i|I)
			BUFFER=$_PI_ASK_CMD
			CURSOR=${#BUFFER}
			zle redisplay
			;;
		(*)
			BUFFER=$original
			CURSOR=${#BUFFER}
			zle redisplay
			;;
	esac
}

zle -N pi-ask-widget
bindkey '^G' pi-ask-widget

# Plain CLI version: ask <question>. Prints the answer, copies the command.
ask() {
	emulate -L zsh
	local question="$*"
	if [[ -z ${question//[[:space:]]/} ]]; then
		print 'usage: ask <question about a shell command>'
		return 2
	fi

	local tmpfile=${TMPDIR:-/tmp}/pi-ask.$$.out
	_pi_ask_fetch_spinner "$question" "$tmpfile"

	local answer
	answer=$(_pi_ask_strip_ansi "$(<"$tmpfile")")
	command rm -f "$tmpfile"

	if [[ -z ${answer//[[:space:]]/} ]]; then
		print -P '%F{red}pi-ask: no answer (check AI_MODEL_ROUTER_API_KEY / network)%f'
		return 1
	fi

	print -r -- "$answer"
	_pi_ask_split "$answer"
	print -r -- "$_PI_ASK_CMD" | command pbcopy
	print -P '\n%F{245}(first command copied to clipboard)%f'
}
