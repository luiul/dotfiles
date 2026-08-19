# List Luis's open (non-Done, non-Epic) ISA Jira tickets in an interactive
# fzf picker, sorted by most recently updated. Adds a Sprint column that
# jira-cli cannot render, so this calls the Jira Cloud REST API directly
# instead of `jira issue list`.
#
# Enter opens the highlighted ticket in the browser. Ctrl-V shows its full
# detail (description + comments) in a pager without leaving the picker.
jira-today() {
	{
		printf 'KEY\tTYPE\tSTATUS\tPRIORITY\tSPRINT\tUPDATED\tSUMMARY\n'
		curl -s -u "$(jira me):$JIRA_API_TOKEN" \
			"https://hellofresh.atlassian.net/rest/api/3/search/jql" \
			--get \
			--data-urlencode 'jql=project = ISA AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic ORDER BY updated DESC' \
			--data-urlencode 'fields=summary,issuetype,status,priority,customfield_10007,updated' \
			--data-urlencode 'maxResults=100' \
		| jq -r '.issues[] | [
				.key,
				.fields.issuetype.name,
				.fields.status.name,
				.fields.priority.name,
				((.fields.customfield_10007 // []) as $s |
					(($s | map(select(.state=="active")) | .[0].name) //
					 ($s | map(select(.state=="future")) | .[0].name) //
					 "Backlog")),
				(.fields.updated[0:16] | sub("T"; " ")),
				.fields.summary
			] | @tsv'
	} | column -t -s $'\t' \
	| fzf --header-lines=1 \
		--preview 'jira issue view {1} --plain' \
		--preview-window='down,50%,wrap,border-top' \
		--bind 'enter:execute(jira open {1})+abort' \
		--bind 'ctrl-v:execute(jira issue view {1} | less -R)'
}
