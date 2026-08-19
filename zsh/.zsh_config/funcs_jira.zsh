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
			--height=90% --layout=reverse --border --info=inline \
			--preview 'jira issue view {2} --plain' \
			--preview-window='down,50%,wrap,border-top' \
			--bind 'enter:execute(jira open {2})+abort' \
			--bind 'ctrl-v:execute(jira issue view {2} | less -R)'
}
