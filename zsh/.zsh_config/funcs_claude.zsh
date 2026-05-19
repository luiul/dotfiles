unalias ask 2>/dev/null

ask() {
	emulate -L zsh
	setopt local_options no_notify no_monitor

	local model=haiku
	local effort=low
	local examples=5
	local bare=1
	local copy=0
	local -a positional=()

	for arg in "$@"; do
		case $arg in
		--help | -h)
			print "Usage: ask [--model=<haiku|sonnet|opus>] [--effort=<low|medium|high>] [--examples=N] [--no-bare] [--copy|-c] <question>"
			print "Defaults: --model=haiku --effort=low --examples=5 (--bare on)"
			print "Example:  ask how do I use fd recursively?"
			return 0
			;;
		--model=*) model="${arg#*=}" ;;
		--effort=*) effort="${arg#*=}" ;;
		--examples=*) examples="${arg#*=}" ;;
		--no-bare) bare=0 ;;
		--copy | -c) copy=1 ;;
		--*)
			print -P "%F{red}✗%f unknown flag: $arg"
			return 1
			;;
		*) positional+=("$arg") ;;
		esac
	done

	if ((${#positional[@]} == 0)); then
		print "Usage: ask [flags] <question>   (run 'ask --help' for flags)"
		return 1
	fi

	if ! command -v claude &>/dev/null; then
		print -P "%F{red}✗%f claude CLI not found"
		return 1
	fi

	local system_prompt="You are a tldr-style command-line assistant. Always answer — never refuse, never ask for clarification, never say the question is incomplete.

Decide which of these the question is, then answer accordingly:

A. BROAD ('how do I use X?', 'what does X do?', 'what is X?'): give a tldr overview — one sentence describing the tool, then the most common example commands.

B. SPECIFIC ('how do I X recursively?', 'how do I X with Y?'): one sentence directly answering the specific behavior asked about (if it's the default, say so explicitly; name the controlling flag), then examples that use those flags/options — not generic tool usage.

C. NOT A CLI QUESTION: answer in 3 sentences max with no examples.

For A and B, format examples as up to ${examples} lines, each: '  \$ <command>  # inline comment'. Examples must be runnable as-is.

Rules:
- Output exactly: one sentence, then example lines (A and B) or up to 3 sentences (C). Nothing else.
- No preamble, no markdown headers, no closing remarks, no bullet points.
- If you genuinely don't recognize the tool/topic, say so in one sentence and stop — but try first."

	local -a cmd=(
		claude --print
		--model "$model"
		--effort "$effort"
		--tools ""
		--no-session-persistence
		--system-prompt "$system_prompt"
	)
	((bare)) && cmd=(claude --bare "${cmd[@]:1}")

	local spinner_pid=
	if [[ -t 2 ]]; then
		{
			typeset -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
			integer i=0
			while :; do
				printf '\r\e[2m%s thinking...\e[0m' "${frames[$((i % 10 + 1))]}" >&2
				sleep 0.1
				((i++))
			done
		} &|
		spinner_pid=$!
	fi

	local raw rc
	raw=$("${cmd[@]}" "${positional[*]}")
	rc=$?

	if [[ -n "$spinner_pid" ]]; then
		kill "$spinner_pid" &>/dev/null
		printf '\r\e[2K' >&2
	fi

	((rc != 0)) && return $rc

	if ((copy)); then
		if command -v pbcopy &>/dev/null; then
			print -rn -- "$raw" | pbcopy
			print -P "%F{green}✓%f copied to clipboard" >&2
		else
			print -P "%F{yellow}⊘%f pbcopy not available" >&2
		fi
	fi

	if [[ -t 1 ]]; then
		print -r -- "$raw" |
			sed -E $'s/^(  )(\\$ )(.*)$/\\1\E[2m\\2\E[0m\E[1m\\3\E[0m/' |
			sed -E $'s/(\E\\[0m)(  *#.*)$/\\1\E[2m\\2\E[0m/'
	else
		print -r -- "$raw"
	fi
}

alias ask='noglob ask'
