# strays: on-demand audit of runaway background processes (dry run of
# reap-strays) plus quick machine health. The launchd agent
# com.luisaceituno.reap-strays does the actual reaping every 15 min and logs
# actions to ~/.cache/strays.log.
strays() {
	echo "=== load ==="
	uptime

	echo "=== stray processes (dry run) ==="
	command ~/.local/bin/reap-strays --dry-run

	echo "=== counts ==="
	local gs_total gs_orphan bridges
	gs_total=$(ps -axo command= | grep -c '[g]itstatusd')
	gs_orphan=$(ps -axo ppid=,command= | awk '$1==1 && /gitstatusd/' | wc -l | tr -d ' ')
	bridges=$(ps -axo command= | grep -c '[s]erver.bundle.mjs')
	echo "gitstatusd: $gs_total total, $gs_orphan orphaned"
	echo "context-mode bridges: $bridges"

	echo "=== recent reaping / orphan events ==="
	tail -6 ~/.cache/strays.log 2>/dev/null || echo "(no strays.log yet)"
	tail -6 ~/.cache/zsh-orphan.log 2>/dev/null | head -6 || true
}
