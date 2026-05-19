ask() {
	emulate -L zsh

	if (($# == 0)); then
		print "Usage: ask <question>"
		print "Example: ask how do I use fd recursively?"
		return 1
	fi

	if ! command -v claude &>/dev/null; then
		print -P "%F{red}✗%f claude CLI not found"
		return 1
	fi

	local system_prompt='You are a tldr-style command-line assistant. Answer with:
1. One short sentence describing what the tool/command does.
2. 3-5 concrete example commands, each on its own line, prefixed with "  $ " and followed by a short "# inline comment" explaining what it does.

Rules:
- No preamble, no markdown headers, no closing remarks.
- Examples must be runnable as-is (real flags, real syntax).
- Prefer the most common/useful flags. Cover the most likely intents.
- If the question is not about a CLI tool or command, answer in 3 sentences max.'

	claude --bare \
		--print \
		--model haiku \
		--effort low \
		--append-system-prompt "$system_prompt" \
		"$*"
}
