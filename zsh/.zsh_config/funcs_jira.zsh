# List my open ISA tickets in an interactive fzf picker. Groups tickets into
# Sprint (current sprint) and Backlog, so it is visually clear which bucket
# each ticket sits in, then by a fixed workflow order (not alphabetical),
# then by most recently updated within each group (not shown, to leave more
# room for the summary). Excludes Done items and Epics.
#
# Workflow order: Open, Ready, Selected for Dev, In Progress,
# Internal Review, then anything else.
#
# Columns: BUCKET, KEY, TYPE, STATUS, SUMMARY, chosen for a quick overview
# and easy scanning.
#
# Enter opens the highlighted ticket in the browser. Ctrl-V shows its full
# detail (description + comments) in a pager without leaving the picker.
# Ctrl-W creates (or reopens) a coppice worktree named after the ticket via
# the jira-worktree script (~/.local/bin), opening its VS Code window with pi
# already running a plan-only prompt for the ticket. It has to call a script,
# not a function: fzf `execute` spawns a non-interactive `$SHELL -c`, which
# never sources .zsh_config.
#
# Every exit leaves a stdout trace: enter/ctrl-w print what they are doing
# before running, and exiting with Esc prints a confirmation from the
# function itself. The action bindings use `become` (not `execute`+`abort`)
# for two reasons: `abort` exits 130, indistinguishable from Esc, while
# `become` replaces fzf with the action so its own exit code surfaces (0 on
# success, 130 only on Esc); and since fzf is gone before the action runs,
# the echo is guaranteed to stay on screen instead of being redrawn away.
jira-today() {
	local base='project = ISA AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic'
	local cols='key,type,status,updated,summary'

	{
		jira issue list -q "$base AND sprint in openSprints()" \
			--plain --no-headers --columns "$cols" --delimiter '|' |
			awk -F'|' -v OFS='|' '{ print "Sprint", $0 }'
		jira issue list -q "$base AND sprint is EMPTY" \
			--plain --no-headers --columns "$cols" --delimiter '|' |
			awk -F'|' -v OFS='|' '{ print "Backlog", $0 }'
	} | awk -F'|' -v OFS='|' '
		{
			bucket_rank = ($1 == "Sprint") ? 0 : 1
			status_rank = 99
			if ($4 == "Open") status_rank = 1
			else if ($4 == "Ready") status_rank = 2
			else if ($4 == "Selected for Dev") status_rank = 3
			else if ($4 == "In Progress") status_rank = 4
			else if ($4 == "Internal Review") status_rank = 5
			print bucket_rank, status_rank, $0
		}
	' |
		sort -t'|' -k1,1n -k2,2n -k7,7r |
		cut -d'|' -f3- |
		awk -F'|' -v OFS='|' '{ print $1, $2, $3, $4, $6 }' |
		{
			printf 'BUCKET|KEY|TYPE|STATUS|SUMMARY\n'
			cat
		} |
		column -t -s '|' |
		fzf --header-lines=1 \
			--header 'enter: open ticket · ctrl-w: worktree + pi plan · ctrl-v: view' \
			--height=90% --layout=reverse --border --info=inline \
			--preview 'jira issue view {2} --plain' \
			--preview-window='down,50%,wrap,border-top' \
			--bind 'enter:become(echo "jira-today: opening {2} in the browser"; jira open {2})' \
			--bind 'ctrl-w:become(echo "jira-today: worktree setup for {2} in progress (pick a repo next)"; jira-worktree {2})' \
			--bind 'ctrl-v:execute(jira issue view {2} | less -R)'
	local rc=$?
	if [[ $rc -eq 130 ]]; then
		echo "jira-today: exited, no action taken"
	fi
	return $rc
}
