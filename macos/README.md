# macos

System-level macOS tweaks that don't fit any single app's package. Two parts:

- `Library/LaunchAgents/` — per-user agents, stowed normally to `~/Library/LaunchAgents/`.
- `Library/LaunchDaemons/` — system-wide daemons. These load from `/Library/LaunchDaemons/`,
  which has no per-user equivalent, so `stow macos` would otherwise create a dead symlink at
  `~/Library/LaunchDaemons` (macOS never reads that path for daemons). A `.stow-local-ignore`
  excludes `Library/LaunchDaemons` from the stow run; install these manually (below).

## `com.luisaceituno.gui-env` (LaunchAgent, stowed)

Runs `~/.local/bin/gui-env-sync.sh` at login to push selected secrets from `~/dotfiles/.env`
into the GUI session environment via `launchctl setenv`, so Dock-launched apps see
them at process start. See the script's own header comment for the full "why".

## `com.luisaceituno.reap-strays` (LaunchAgent, stowed)

Runs `~/.local/bin/reap-strays --apply` every 900 seconds. The launcher uses `/opt/homebrew/bin/node` or `/usr/local/bin/node`, without relying on launchd's PATH. No extra dependencies are needed.

Without arguments, the command is read-only. `--dry-run` is also read-only. `strays` uses `--dry-run --report` for counts, skipped tmux sessions, and recent safe events. `--help` does no process or file work. Unknown flags and conflicting modes fail before any action.

### Process rules

Each candidate must have the current user's UID and PPID 1. Matching uses the executable from `ps comm`, not words inside a command. The final check reads PID, UID, start time, executable, and classification again before each signal.

- `gitstatusd` must use `~/.cache/gitstatus/gitstatusd-darwin-<architecture>` as its executable.
- A context-mode bridge must use a known Node or Bun executable. Its first script argument must be the absolute `~/.pi/agent/npm/node_modules/context-mode/server.bundle.mjs` path. Other bundles do not match.
- Zsh must use a known Zsh executable, have no tty, and be at least 600 seconds old. It must be interactive or a login shell. `-c`, script operands, stdin scripts, and ambiguous arguments do not match. Detached noninteractive scripts stay untouched.

The engine records PID, UID, start time, classification, and the time of a successful TERM. It sends KILL only after at least 900 seconds of grace. Failed TERM does not start grace. Successful KILL stays recorded until that process identity disappears. PID reuse starts a new TERM cycle, never an inherited KILL.

State is private JSON in `~/.cache/reap-strays/state.json`. Writes use a private temporary file, fsync, and atomic rename. A directory lock serializes apply runs. Its private `owner.json` records PID, UID, and start time. Recovery needs two process reads that prove the original owner is gone, plus unchanged lock identity and metadata. Reused PIDs do not preserve a dead owner's lock. Live, unreadable, or ambiguous owners prevent recovery.

A short-lived `lock-recovery` directory serializes stale-lock recovery. A crash before owner metadata is saved, or during recovery, can leave an ambiguous lock. These locks fail closed and need manual recovery. Verify no apply or registration run is active before removing `lock/owner.json`, `lock`, or `lock-recovery` under `~/.cache/reap-strays/`. Never remove a lock just because it is old.

Failed signals and failed tmux cleanup return exit code 1. Invalid arguments return 2. A held or ambiguous apply lock returns 3. Successful checks return 0.

The old PID-only `~/.cache/strays-termed` file is ignored. It cannot authorize escalation. Dry runs do not create a lock, state, or log, and do not use escalation state.

### Registered tmux tasks

Only the default tmux server is inspected. Age alone never permits session cleanup. Register a detached task with a live owner and a future deadline:

```sh
reap-strays --register-tmux ag-task --owner "$owner_pid" --deadline "$deadline_epoch"
```

The helper reads the owner's UID and start time from `ps`. It verifies the session and private windows, sets `@agent_owner` and `@agent_deadline`, and confirms the result. It uses the same lock as apply runs. Registration never signals processes or kills sessions. Partial option writes clear the deadline first, so failure does not leave an old expired deadline armed.

Use the PID of the task's controlling process, not a short-lived setup command. The owner format is `PID:START_EPOCH_SECONDS`. The helper converts BSD `ps lstart` in the machine's local time zone to epoch seconds. Callers do not need to parse start time themselves.

An eligible session must satisfy every rule:

- Its name starts with `ag-` and uses only letters, digits, underscores, or hyphens.
- It has no attached clients and no windows linked into other sessions.
- `@agent_deadline` is an expired epoch timestamp in whole seconds.
- `@agent_owner` is `PID:START_EPOCH_SECONDS`, using the owner's `ps lstart` time converted to epoch seconds.
- The owner PID is absent, or its start time differs. A live owner prevents cleanup, even after the deadline.

Missing marks, unreadable owners, active deadlines, shared windows, and attached sessions are skipped and reported. The engine reads the server identity, session identity, options, owner, and window links again before cleanup. Each tmux client call has a five-second timeout. Failed cleanup is reported as failed, not as success.

### Logs and verification

New events use `~/.cache/reap-strays/events.log`. They contain metadata only, never process arguments. Files use mode 600 inside a mode 700 directory. Rotation keeps the current log and three backups, each at most 256 KiB. The report shows only safe fields from recent events. It does not print old `~/.cache/strays.log` or `~/.cache/zsh-orphan.log` entries.

Run the isolated fixture tests and a live dry run:

```sh
node scripts/test-reap-strays.mjs
zsh -n macos/.local/bin/reap-strays zsh/.zsh_config/funcs_strays.zsh
plutil -lint macos/Library/LaunchAgents/com.luisaceituno.reap-strays.plist
~/.local/bin/reap-strays --dry-run --report
```

The tests inject process reads, time, signals, files, and tmux calls. They never signal real processes or kill real sessions. BSD `ps` exposes start time only to the second. The last read narrows races but cannot remove the small interval between verification and a signal. Ambiguous input fails closed.

## `com.luisaceituno.awdl-disable` (LaunchDaemon, manual install)

Keeps the `awdl0` interface (Apple Wireless Direct Link — the radio used by AirDrop, AirPlay,
Sidecar, and Instant Hotspot) administratively down. AirDrop/AirPlay are disabled by HelloFresh
company policy on this Mac, so the interface is pure downside: AWDL periodically forces the
Wi-Fi radio to hop off-channel for peer discovery, which shows up as brief `en0` link blips.

### Why this exists

Diagnosed 2026-09-14: Zscaler Client Connector's ZPA tunnel kept dropping, in both the home and
office networks. `ZSATunnel_*.log` in `/Library/Application Support/Zscaler/log-*/` showed every
tunnel restart preceded by a burst of `SCU:[SCURunLoop]dynamicStoreCallBack` events carrying
`State:/Network/Interface/en0/AirPort/AWDLRealTimeMode`, `.../BSSID`, and `.../AirPlay` keys,
followed within seconds by `SERVER_DOWN_ERROR` on both ZPA and ZIA, then a `SIGTERM` to
`ZscalerTunnel` and a full tunnel restart. `LuLu` and iCloud Private Relay were both ruled out
first (LuLu already had full allow rules for the three Zscaler binaries; Private Relay was off).
Taking `awdl0` down stopped the AWDL-driven link blips and the tunnel has stayed up since.

### Install on a new machine

```sh
sudo cp macos/Library/LaunchDaemons/com.luisaceituno.awdl-disable.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.luisaceituno.awdl-disable.plist
sudo chmod 644 /Library/LaunchDaemons/com.luisaceituno.awdl-disable.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.luisaceituno.awdl-disable.plist
```

`ifconfig awdl0 down` only holds until macOS (or a Continuity feature) brings the interface back
up. The daemon reapplies it every 30s (`StartInterval`) plus once at boot (`RunAtLoad`), instead
of a one-shot command that silently stops working.

### Revert (re-enable AirDrop/AirPlay/Sidecar)

```sh
sudo launchctl bootout system/com.luisaceituno.awdl-disable
sudo rm /Library/LaunchDaemons/com.luisaceituno.awdl-disable.plist
sudo ifconfig awdl0 up
```

### Verify

```sh
ifconfig awdl0          # should show no UP/RUNNING flags
sudo launchctl print system/com.luisaceituno.awdl-disable   # should show the job loaded
```
