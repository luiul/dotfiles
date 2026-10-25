# Window title, mirrors the VS Code template (window.title in the vscode
# package): repo root path, separator, git branch.
# Example: "~/dotfiles • main". While a command runs: "npm test • ~/dotfiles • main".
#
# Also reports the working directory to the terminal via OSC 7 (startup
# report; see the OSC 7 block at the bottom for why Ghostty needs it).
#
# Ghostty's own automatic title is disabled in the Ghostty config
# (shell-integration-features = no-cursor,no-title), so this hook owns the title.
# Works in any terminal that supports OSC 0 (Ghostty, Terminal.app, iTerm2, ...).

# Sets _my_title_root (worktree root) and _my_title_branch. Returns 1 when
# $PWD is outside a git repo. Uses only zsh builtins: no git fork per prompt.
_my_title_repo_info() {
	typeset -g _my_title_root _my_title_branch
	local dir=$PWD gitdir="" g="" head=""
	while true; do
		if [[ -d $dir/.git ]]; then
			gitdir=$dir/.git
			_my_title_root=$dir
		elif [[ -f $dir/.git ]]; then
			# Linked worktree: .git is a "gitdir: <path>" pointer file.
			read -r g < $dir/.git
			g=${g#gitdir:}
			g=${g## }
			[[ $g == /* ]] || g="$dir/$g"
			[[ -n $g && -d $g ]] || return 1
			gitdir=${g:A}
			_my_title_root=$dir
		fi
		if [[ -n $gitdir ]]; then
			read -r head < $gitdir/HEAD 2>/dev/null || return 1
			if [[ $head == ref:\ refs/heads/* ]]; then
				_my_title_branch=${head#ref: refs/heads/}
			else
				_my_title_branch=${head[1,7]}  # detached HEAD
			fi
			return 0
		fi
		[[ $dir == / ]] && return 1
		dir=${dir:h}
	done
}

_my_title_render() {
	local title cmd=$1 root=${(D)PWD}
	if _my_title_repo_info; then
		root=${(D)_my_title_root}
		if [[ -n $cmd ]]; then
			title="$cmd • $root • $_my_title_branch"
		else
			title="$root • $_my_title_branch"
		fi
	else
		if [[ -n $cmd ]]; then
			title="$cmd • $root"
		else
			title=$root
		fi
	fi
	# Terminal controls in paths, branches, or commands must not inject OSC codes.
	title=${title//[[:cntrl:]]/}
	printf '\e]0;%s\a' "$title"
}

_my_title_precmd() {
	_my_title_render ""
}

_my_title_preexec() {
	local cmd=$1
	(( $#cmd > 40 )) && cmd="${cmd[1,40]}..."
	_my_title_render "$cmd"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _my_title_precmd
add-zsh-hook preexec _my_title_preexec

# OSC 7 working directory report at shell startup.
#
# Ghostty tracks each window's working directory from OSC 7 reports
# (kitty-shell-cwd format) and opens new windows, tabs, and splits (cmd+n,
# cmd+t) in the focused window's last tracked directory. It seeds every
# surface with the shell's initial directory, but only OSC 7 reports update
# the tracked value afterwards. Ghostty's own shell integration defers all
# hook registration to the first prompt: it only appends
# _ghostty_deferred_init to precmd_functions. A `zsh -ic 'exec <tui>'` window
# (piw, and any other tool wrapper) never shows a prompt, so it never reports:
# its directory stays invisible to Ghostty's session view (AppleScript
# `working directory`, session search) and the tracked value goes stale if the
# shell cd's before exec'ing the TUI. Emit one report here so every window,
# including TUI-only ones, is known to Ghostty from startup. Write to the
# controlling terminal, never to stdout: tool wrappers capture stdout, and an
# escape sequence in captured output would corrupt it. Only live directories
# are reported: reporting a deleted directory makes Ghostty fall back to /
# when opening new windows from this one (ghostty discussion #10448).
if [[ $TERM_PROGRAM == ghostty && -n $TTY && -w $TTY && $PWD == /* && -d $PWD ]]; then
	printf '\e]7;kitty-shell-cwd://%s%s\a' "$HOST" "$PWD" > $TTY
fi
