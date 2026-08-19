# Agent Radar

Herdr plugin implementing dotfiles issue [#11](https://github.com/luiul/dotfiles/issues/11),
phases 0 to 2: read-only visibility into agent CLI sessions running outside
herdr's own panes.

## The gap this fills

Herdr's Agents section only ever lists agents running inside a pane herdr
itself created. There is no socket method to register an agent unbound to a
pane (confirmed against `herdr api schema --json`: every `agent.*`/`pane.*`
method takes or resolves a pane id). An agent started in a plain terminal
tab, outside herdr, is invisible to it.

## What this plugin does

A watcher process polls the current user's processes for herdr's known
agent kinds (`pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`,
`cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`,
`droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `maki`), resolves each
one's cwd, and cross-references against `herdr pane process-info` to split
matches into:

- **tracked**: already visible in herdr's own Agents section, ignored.
- **external**: not visible to herdr today. This is the gap.

External agents are matched to a herdr workspace by git-worktree-aware
repo identity (`git rev-parse --git-common-dir`), not plain path equality,
so a worktree checkout still matches the right workspace even when its
path differs from the workspace's own cwd.

Two ways to see the result:

1. A short-TTL `workspace.report_metadata` badge (`external_agent=<kind>`)
   on any workspace with a matching external agent. Visible today in
   herdr's existing sidebar, using the same `workspace.report_metadata`
   mechanism proposed for the VS Code presence plugin in issue #10 (not
   yet implemented as of this writing).
2. A read-only "Agent Radar" pane listing the full registry, including
   external agents with no matching workspace at all.

There is no control surface (no send-keys, no prompt): an externally
started process has no pty herdr can attach to. This is visibility only.

## Files

- `herdr-plugin.toml` — manifest: one `startup` hook, two actions
  (`start-watcher`, `open-radar`), one pane (`radar`).
- `watch.mjs` — the watcher. Scans, cross-references, matches, writes
  `registry.json`, reports/clears workspace badges.
- `start-watcher.sh` — daemonizes `watch.mjs`, guarded by a pidfile so
  repeated `startup` firings (session restore, live handoff) never stack
  more than one running watcher.
- `radar.sh` — the pane viewer, redraws `registry.json` every 2s.
- `open-radar.sh` — opens the `radar` pane via `herdr plugin pane open`.

## Why there is a `start-watcher` action

Herdr `[[startup]]` hooks are **not supervised daemons**: they fire once
per session-restore or live-handoff, not on `plugin link`/`enable`, and
there is no stop hook. `start-watcher.sh` backgrounds the real loop itself
and exits immediately, which satisfies herdr's one-shot contract while the
loop keeps running detached. The `start-watcher` action lets you (re)start
it on demand without restarting herdr's server, which the
[herdr skill file](https://herdr.dev) explicitly warns against doing
casually from an active session.

Because there is no stop hook either, the watcher self-checks
`herdr plugin list --json` once per poll cycle and exits on its own if the
plugin is disabled or unlinked. `herdr plugin disable luiul.agent-radar`
is therefore enough to stop it; you do not need to hunt down and kill the
pid manually. If you ever do need to: the pid file and `watch.log` live
under the plugin's `HERDR_PLUGIN_STATE_DIR`
(`~/.local/state/herdr/plugins/luiul.agent-radar/` on this machine).

## Setup

```bash
herdr plugin link ~/dotfiles/herdr/plugins/agent-radar
herdr plugin action invoke start-watcher --plugin luiul.agent-radar
```

After that, the `startup` hook keeps it running across herdr restarts and
live handoffs on its own. Open the radar pane with `prefix+a` (bound in
`dotfiles/herdr/.config/herdr/config.toml`) or
`herdr plugin action invoke open-radar --plugin luiul.agent-radar`.

## Configuration

Optional overrides via `$HERDR_PLUGIN_CONFIG_DIR/config.env`
(`herdr plugin config-dir luiul.agent-radar` prints the path), sourced by
`start-watcher.sh` before launching:

```sh
AGENT_RADAR_POLL_MS=10000   # default 7000
AGENT_RADAR_TTL_MS=30000    # default poll_ms * 3
AGENT_RADAR_DRY_RUN=1       # log intended report-metadata calls, mutate nothing
```

## Known limitations

- Matches on the process's own executable basename plus "has a controlling
  tty" plus "second argv token is not a known subcommand/flag" (to filter
  out things like `codex mcp`). This is a heuristic, not exact: a renamed
  binary or an unusual wrapper script can be missed or misclassified.
- Same machine, same user only. An agent in a container, over SSH on
  another host, or under a different local user is invisible to a local
  `ps` scan.
- Some kind names (`amp`, `cursor`) are common words; a coincidentally
  named unrelated binary with a real tty could false-positive. Not
  observed in practice yet, but worth knowing.
- A true row inside herdr's native Agents section (rather than a sidebar
  badge plus a side pane) needs a herdr API that does not exist yet. See
  issue #11's phase 3 for the upstream ask.
