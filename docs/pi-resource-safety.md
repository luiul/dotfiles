# Pi background resource safety

Pi sessions and SDK agents own helpers and timers. A helper with a live owner is not automatically a leak. Check ownership, activity, and an explicit deadline before stopping it.

## Resource budgets

`pi/.pi/agent/subagents.json` sets three background agents and two foreground agents per Pi session. Each agent has a default limit of 60 turns, then three grace turns to finish its report. Callers can set a different turn limit for a known task. Nested agents and resumed foreground agents have exceptions in the installed runner, so these limits are not a machine-wide process cap.

`resource-budget.ts` supplies a 120-second default for `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`. An explicit positive timeout can allow a longer build. Background execution needs an explicit timeout and a shutdown step. `background: true` is not permission to leave a server running after the task.

The guard checks the installed context-mode resource patch before each ctx call. Missing or changed patch files block ctx tools instead of silently restoring unsafe execution. An approval at the start of a run does not survive package drift. Bash and other tools remain available for recovery.

## Context-mode lifecycle patch

The patch supports context-mode `1.0.169`. The Pi package declaration pins that version. The patch script rejects other versions and unexpected source changes.

From the repository root:

```sh
node scripts/patch-context-mode.mjs --check
node scripts/patch-context-mode.mjs --apply
node scripts/patch-context-mode.mjs --restore
```

The patch saves original files under a private cache directory before replacing them. A private transaction journal records approved before and after hashes before file replacement. After an interrupted apply or restore, the installer can recover that recorded transaction. Unknown drift and live or ambiguous lock owners still block changes.

On Unix, a quiet shell owns each execution group until cleanup. It blocks on a parent-owned pipe instead of polling processes. A short `/usr/bin/perl` exec shim restores INT and QUIT handlers before replacing itself with the workload. It leaves no extra retained process. Child replacement cannot lose the group identity. Parent exit closes the pipe and reclaims the group. Rust compilation keeps its sandbox until the compiled program finishes. Explicitly creating a new session or group escapes this ownership boundary and still needs a separate shutdown step.

The patch bounds omitted execution deadlines and handles cancellation and failed startup. Cancelling one tool can reclaim its bridge and fail sibling calls on that bridge. The next call starts a new helper.

Pi spawns its bridge directly. The bridge marks this ownership so the lifecycle guard can check its parent without launching `ps` every second. Other hosts keep their wrapper ancestry checks.

`pi-resources-patch` reapplies the patch. `pi-extensions-upgrade` and `pi-extensions-audit-fix` call it after a successful update. A direct `pi update --extensions`, reinstall, or forced audit fix can replace package files. Run `pi-resources-patch` afterwards, then `/reload` in an idle session. Do not edit installed package files by hand.

Existing sessions do not reload code automatically. Reload or restart them when their work is complete. Do not stop active sessions just to apply these changes. When the patch revision changes, update its guard and installer together. Do not deploy a new installed revision while the live guard still expects an older one.

## Footer lifecycle

The status bar runs only in terminal UI mode. Headless SDK, RPC, JSON, and print sessions do not start footer polling. `/statusbar` stops polling when disabled and restarts it when enabled. Session replacement and shutdown clear its timers. Its two-second Git deadline uses KILL so a TERM-resistant child cannot hold the refresh slot.

## Watchdog boundaries

`strays` is a read-only audit. The watchdog is a fallback for specific abandoned helpers, not a general process killer. Its launchd job runs every 15 minutes. See [macOS setup](../macos/README.md) for installation, identity rules, and tmux ownership.

Keep lazy MCP connections, proxy tools, and the ten-minute idle timeout in `mcp-adapter.json`. Do not add a second context-mode MCP entry. The Pi package already supplies those tools.

## Verification

```sh
node scripts/test-reap-strays.mjs
node scripts/test-reaper-live.mjs
bun scripts/test-status-bar-resources.ts
node scripts/test-status-bar-live.mjs
bun scripts/test-resource-budget.ts
node scripts/test-resource-budget-live.mjs
node scripts/test-resource-budget-live.mjs --context-mode
bun scripts/test-pi-resource-config.ts
zsh -f scripts/test-pi-resource-hooks.zsh
node scripts/test-context-mode-resources.mjs
node scripts/test-context-mode-patch-recovery.mjs
node scripts/test-pi-resource-e2e.mjs
strays
```

The Pi resource test starts isolated RPC and tmux sessions without network model calls. It counts real footer Git subprocesses and checks disable, enable, and shutdown behavior. The budget test uses a local stream fixture to call nested tools through Pi's real tool context. Its `--context-mode` option also verifies the installed patched extension. Every test process has a deadline and cleanup.

Measure CPU from the change in cumulative process CPU time over a fixed interval. A CPU value of 100 percent means one logical core. Summed RSS is approximate process residency, not unique physical memory. Compare quiet sessions separately from agents doing work.
