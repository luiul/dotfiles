# Read-only audit. Counts and recent events use the same precise matcher as the reaper.
strays() {
	echo "=== load ==="
	uptime

	echo "=== stray processes and registered tmux tasks (dry run) ==="
	command ~/.local/bin/reap-strays --dry-run --report
}
