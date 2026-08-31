# List my open ISA tickets in an interactive fzf picker. The ticket rows come
# from the jira-today-list script (~/.local/bin), which groups tickets into
# Sprint/Backlog buckets and orders them by workflow state; see its header
# comment for the details. It has to be a script, not inline here, because
# fzf's ctrl-r `reload` re-runs the producer in a non-interactive
# `$SHELL -c`, which never sources .zsh_config (same reason jira-worktree is
# a script).
#
# Enter opens the highlighted ticket in the browser. Ctrl-V shows its full
# detail (description + comments) in a pager without leaving the picker.
# Ctrl-C copies the ticket key to the clipboard (pbcopy) and stays in the
# picker, confirming via the prompt line; since ctrl-c is remapped, plain
# aborting is Esc only. Ctrl-R reloads the ticket list and resets the
# prompt. Ctrl-W creates (or reopens) a coppice worktree named after the
# ticket via the jira-worktree script (~/.local/bin) and opens its VS Code
# window; the script asks whether pi should also start with a plan-only
# prompt for the ticket (default yes, decline for just the window).
#
# Every exit leaves a stdout trace: enter/ctrl-w print what they are doing
# before running, and exiting with Esc prints a confirmation from the
# function itself. The action bindings use `become` (not `execute`+`abort`)
# for two reasons: `abort` exits 130, indistinguishable from Esc, while
# `become` replaces fzf with the action so its own exit code surfaces (0 on
# success, 130 only on Esc); and since fzf is gone before the action runs,
# the echo is guaranteed to stay on screen instead of being redrawn away.
jira-today() {
	jira-today-list |
		fzf --header-lines=1 \
			--header 'enter: open ticket · ctrl-w: worktree (asks re: pi plan) · ctrl-v: view · ctrl-c: copy key · ctrl-r: reload' \
			--height=90% --layout=reverse --border --info=inline \
			--preview 'jira issue view {2} --plain' \
			--preview-window='down,50%,wrap,border-top' \
			--bind 'enter:become(echo "jira-today: opening {2} in the browser"; jira open {2})' \
			--bind 'ctrl-w:become(echo "jira-today: worktree setup for {2} in progress (pick a repo next)"; jira-worktree {2})' \
			--bind 'ctrl-v:execute(jira issue view {2} | less -R)' \
			--bind 'ctrl-c:execute-silent(echo -n {2} | pbcopy)+transform-prompt(echo jira-today: copied {2} ·)' \
			--bind 'ctrl-r:reload(jira-today-list)+transform-prompt(echo -n "> ")'
	local rc=$?
	if [[ $rc -eq 130 ]]; then
		echo "jira-today: exited, no action taken"
	fi
	return $rc
}
