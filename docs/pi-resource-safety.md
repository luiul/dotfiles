# Pi background resource safety

Pi sessions and SDK agents own helpers and timers. A helper with a live owner is not automatically a leak. Check ownership, activity, and an explicit deadline before stopping it.

## Resource budgets

`pi/.pi/agent/subagents.json` sets three background agents and two foreground agents per Pi session. Each agent has a default limit of 60 turns, then three grace turns to finish its report. Callers can set a different turn limit for a known task. Nested agents and resumed foreground agents have exceptions in the installed runner, so these limits are not a machine-wide process cap.

Package-managed worktree isolation is disabled. Its raw Git worktrees, automatic commits and forced cleanup bypass this setup's Worktrunk and review rules. Delegation stays available. Create an isolated checkout through `wt` when needed, then run the worker in that explicit checkout.

`resource-budget.ts` supplies a 120-second default for `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`. An explicit positive timeout can allow a longer build. Background execution needs an explicit timeout and a shutdown step. `background: true` is not permission to leave a server running after the task.

The guard checks the installed context-mode resource patch against the reviewed hashes in `pi/.pi/agent/patches/context-mode/approved-files.json`. The patcher uses that same manifest. Changing installed files and their marker together does not approve new bytes. Missing or changed patch files block ctx tools instead of silently restoring unsafe execution. Bash and other tools remain available for recovery.

## Context-mode lifecycle patch

The patch supports context-mode `1.0.169`. The Pi package declaration pins that version. The patch script rejects other versions and unexpected source changes.

From the repository root:

```sh
node scripts/patch-context-mode.mjs --check
node scripts/patch-context-mode.mjs --apply
node scripts/patch-context-mode.mjs --restore
```

The patch saves original files under a private cache directory before replacing them. It tracks child process groups, bounds omitted execution deadlines, and handles cancellation and failed startup. Cancelling one tool can reclaim its bridge and fail sibling calls on that bridge. The next call starts a new helper.

Pi spawns its bridge directly. The bridge marks this ownership so the lifecycle guard can check its parent without launching `ps` every second. Other hosts keep their wrapper ancestry checks.

`pi-resources-patch` reapplies and verifies the patch. `pi-extensions-upgrade` and `pi-extensions-audit-fix` run it after package changes, including failed update or audit attempts. A command can replace some files before it returns a failure. The wrapper preserves that failure and reports any recovery failure separately. A successful update is not reported as successful if patch restoration or verification fails. A direct `pi update --extensions`, reinstall, or forced audit fix can replace package files. Run `pi-resources-patch` afterwards, then `/reload` in an idle session. Do not edit installed package files by hand.

Existing sessions do not reload code automatically. Reload or restart them when their work is complete. Do not stop active sessions just to apply these changes.

## Footer lifecycle

The status bar runs only in terminal UI mode. Headless SDK, RPC, JSON, and print sessions do not start footer polling. `/statusbar` stops polling when disabled and restarts it when enabled. Session replacement and shutdown clear its timers.

The footer uses public effective settings and the native compaction resolver, including model overrides and zero reserve. Usage includes supported assistant, tool-result, cache-warming and summary entries on the selected branch. Branch and frame caches avoid repeated history scans and layout work. Settings are checked before frame reuse, so settings changes apply on the next paint. The caches add no timer or file read.

## Watchdog boundaries

`strays` is a read-only audit. The watchdog is a fallback for specific abandoned helpers, not a general process killer. Its launchd job runs every 15 minutes. See [macOS setup](../macos/README.md) for installation, identity rules, and tmux ownership.

Keep lazy MCP connections, proxy tools, and the ten-minute idle timeout in `mcp-adapter.json`. Do not add a second context-mode MCP entry. The Pi package already supplies those tools.

## Benchmarks

The maintained fixtures compare saved source with the candidate on the same installed Pi. Run them sequentially, with no other benchmark workers. Keep baseline source and the reports for review:

```sh
node scripts/bench-pi-setup.mjs --baseline /path/to/saved-checkout --mode rpc --output /tmp/pi-setup-rpc.json
node scripts/bench-pi-setup.mjs --baseline /path/to/saved-checkout --mode tui --output /tmp/pi-setup-tui.json
bun scripts/bench-status-bar-render.ts --baseline /path/to/saved-status-bar.ts --output /tmp/pi-footer-render.json
node scripts/bench-resource-guard.mjs --baseline /path/to/saved-resource-budget.ts --output /tmp/pi-guard.json
```

The custom-stack fixture uses private settings and local responses. It checks unchanged command and tool declarations and prompt hashes. Each TUI turn has a unique marker, so an older reply cannot satisfy the final-paint check. Third-party packages and background memory review are excluded. The fixture does not measure provider latency, model quality, billing or provider caching.

The 24 November 2026 footer render fixture used the complete 1,580-byte settings snapshot and nine rotated trials. At 120 columns, warm cached renders changed from 21.86 to 6.28 microseconds. Long-history renders changed from 86.28 to 6.49 microseconds. Those are isolated render measurements, not whole-task speed claims. Per-call resource hash checks stayed near 0.75 ms. Removing the discarded run-boundary hash check removed another roughly 0.75 ms check without weakening per-call validation.

Seven five-second idle slices in regular mode measured 10 ms median CPU for both versions. Fullscreen measured 0 ms baseline and 10 ms candidate medians. Both stayed at or below one 10 ms sampling step per slice. Output bytes and Git launch counts were unchanged. This is not proof of zero CPU cost. See [the setup review](https://github.com/luiul/dotfiles/issues/112) for exact reports, noise and the separate Hermes child-start tradeoff.

## Verification

```sh
node scripts/test-reap-strays.mjs
node scripts/test-reaper-live.mjs
bun scripts/test-status-bar-resources.ts
bun scripts/test-resource-budget.ts
node scripts/test-resource-budget-live.mjs
bun scripts/test-pi-resource-config.ts
zsh -f scripts/test-pi-resource-hooks.zsh
node scripts/test-context-mode-resources.mjs
node scripts/test-pi-resource-e2e.mjs
strays
```

The Pi resource test starts isolated RPC and private Rex sessions without model calls. It counts real footer Git subprocesses and checks disable, enable, and shutdown behavior. Every test process has a deadline and cleanup.

Measure CPU from the change in cumulative process CPU time over a fixed interval. A CPU value of 100 percent means one logical core. Summed RSS is approximate process residency, not unique physical memory. Compare quiet sessions separately from agents doing work.
