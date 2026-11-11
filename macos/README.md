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

## `md-to-rtf` (command, stowed)

Converts a Markdown file to Mac-style RTF (Helvetica 12 pt, Menlo for code) and puts it on the clipboard, so you can paste a draft into Mail, Outlook, or Gmail with bold, links, lists, and line breaks kept. It replaces the old `md_to_rtf` zsh function that used pandoc.

```sh
md-to-rtf ~/scratch/email.md              # writes email.rtf next to it and copies it
md-to-rtf draft.md --no-copy              # file only
md-to-rtf draft.md --no-file              # clipboard only
md-to-rtf draft.md --font Arial --size 14
md-to-rtf draft.md --join-lines           # for hard-wrapped Markdown
cat draft.md | md-to-rtf -                # stdin to clipboard
cat draft.md | md-to-rtf - --no-copy -o draft.rtf  # stdin to a file
```

- Stdin with `--no-copy` needs `--output`. The command rejects calls that would produce nothing.
- A single newline is a line break, so `To:`, `Cc:`, and signature lines stay on separate lines. Use `--join-lines` to join them.
- Sizes use CSS px on purpose. `textutil` turns `12px` into RTF 12 pt, but `12pt` into 16 pt.
- `pbpaste` shows plain text only. To check the clipboard RTF, run `osascript -e 'clipboard info'`. It should list `«class RTF »`.
- Needs macOS `textutil` and `pbcopy`. Python dependencies come from the `uv run --script` header.

Test: `uv run --script scripts/test-md-to-rtf.py`

## `mail-repair` (command, stowed)

Backs up Apple Mail and repairs the known IMAP copy crash (`UIDs are required for UID command`). Run it from zsh after quitting Mail. After publication and live deployment, `stow macos` installs the command into `~/.local/bin`, which is already on the zsh path. It needs `uv` and no extra Python packages.

```sh
mail-repair --dry-run       # inspect only, no backup or repair
mail-repair                # preview, confirm, back up, then repair
mail-repair --backup-only   # verified backup, no repair
```

The repair needs a matching Mail crash report from the last seven days. It accepts only the checked V10 database layout. It removes an invalid copy or move operation only when that operation has one item, no valid UID, no dependent flags or labels, and a retained local message. Mixed or unknown operations stop without repair.

Type `repair` at the prompt to confirm. There is no `--yes` flag. A private lock blocks concurrent repairs. The command checks that Mail stays closed before backup and before commit. Do not open Mail while it runs.

Each backup goes in a new private directory under `~/Library/Application Support/Mail Repair Backups/`. It includes the database with committed WAL data, the current rule files, `PersistenceInfo.plist`, and a manifest with file hashes and table counts. Database integrity is checked before and after backup. The repair runs in a transaction and compares every table against the backup before commit. Only the approved queue rows may change.

Messages, accounts, and rules stay unchanged. SQLite may create temporary WAL coordination files even during `--dry-run`; it does not change message or queue rows during inspection. A removed pending move or copy may not finish. Unlike the one-time diagnosis, this command does not disable the GitHub Notifications rule or any other rule. It never rebuilds mailboxes, restores backups, or opens or quits Mail.

Full Disk Access is needed for the terminal app or Herdr Core that runs the command. If access is blocked, enable it in System Settings, Privacy & Security, Full Disk Access.

After repair, open Mail and check syncing. If Mail asks about restoring windows after a crash, choose **Don’t Reopen** for a fresh window. Keep the backup. Do not restore it over newer mail changes without checking those changes first. The backup is local Mail state, not an export of all message files or a backup of server mail.

The Mail database is private Apple storage. A future layout change stops the command rather than applying an old repair.

Test: `uv run --script scripts/test-mail-repair.py`. Tests use isolated databases and never change real Mail data.

## `com.luisaceituno.reap-strays` (LaunchAgent, stowed)

Runs `~/.local/bin/reap-strays --apply` every 900 seconds. The launcher uses `/opt/homebrew/bin/node` or `/usr/local/bin/node`, without relying on launchd's PATH. No extra dependencies are needed.

Without arguments, the command is read-only. `--dry-run` is also read-only. `strays` uses `--dry-run --report` for counts, skipped tmux sessions, and recent safe events. `--help` does no process or file work. Unknown flags and conflicting modes fail before any action.

### Process rules

Each candidate must have the current user's UID and PPID 1. Matching uses the executable from `ps comm`, not words inside a command. The final check reads PID, UID, start time, executable, and classification again before each signal.

- `gitstatusd` must use `~/.cache/gitstatus/gitstatusd-darwin-<architecture>` as its executable.
- A context-mode bridge must use a known Node or Bun executable. Its normalized full command must be that runtime followed by the exact absolute `~/.pi/agent/npm/node_modules/context-mode/server.bundle.mjs` path. Extra flags or arguments do not match. Paths with embedded spaces are ambiguous in `ps` output and stay untouched.
- Zsh must use a known Zsh executable, have no tty, and be at least 600 seconds old. A simple option group must contain an explicit `i`, such as `-i` or `-il`. Login-only `/bin/zsh -l` and `-zsh` do not prove interactivity and stay untouched. `-c`, script operands, stdin flags, and ambiguous arguments do not match. Detached noninteractive stdin scripts stay untouched.

The engine records PID, UID, start time, classification, and the time of a successful TERM. It sends KILL only after at least 900 seconds of grace. Failed TERM does not start grace. Successful KILL stays recorded until that process identity disappears. PID reuse starts a new TERM cycle, never an inherited KILL.

Successful signal timestamps use the latest observed time before or after the signal. A backward clock step cannot record TERM before process start, or KILL before TERM plus grace. Grace checks still use the current clock, never a forward-clamped clock. Clock rollback can delay escalation, but cannot shorten recorded grace. Failed signals do not change successful TERM or KILL state.

State is private JSON in `~/.cache/reap-strays/state.json`. Writes use a private temporary file, fsync, and atomic rename. A directory lock serializes apply runs. Its private `owner.json` records PID, UID, and start time. Recovery needs two process reads that prove the original owner is gone, plus unchanged lock identity and metadata. Reused PIDs do not preserve a dead owner's lock. Live, unreadable, or ambiguous owners prevent recovery.

Handled owner-file open, write, or fsync failures remove only the new lock directory and this run's partial owner file. Cleanup checks device, inode, and owner content. Changed directories, replaced owner files, foreign contents, and concurrent files stay untouched. A retry can acquire the lock after the filesystem recovers.

A short-lived `lock-recovery` directory serializes stale-lock recovery. A crash before owner metadata is saved, or during recovery, can leave an ambiguous lock. These locks fail closed and need manual recovery. Verify no apply or registration run is active before removing `lock/owner.json`, `lock`, or `lock-recovery` under `~/.cache/reap-strays/`. Never remove a lock just because it is old.

Failed signals, failed tmux cleanup, and Rex registry inspection or cleanup failures return exit code 1. Invalid arguments return 2. A held or ambiguous apply lock returns 3. Successful checks return 0.

The old PID-only `~/.cache/strays-termed` file is ignored. It cannot authorize escalation. Dry runs do not create a lock, state, or log, and do not use escalation state.

### Private Rex fixtures

Terminal tests use `scripts/rex-test-driver.mjs`, not the desktop Rex endpoint. The driver registers its private root, socket, server, controller and exec targets with `reap-rex-tests.mjs` before publishing readiness. `reap-strays` includes these explicit records in dry-run and apply reports. It never discovers arbitrary Rex sessions or processes.

The backstop requires an expired deadline and absent owner and supervisor. It verifies process start identities and fixture metadata again before TERM. A successful TERM permits KILL after at least ten seconds. Ambiguous metadata blocks cleanup and returns a failure status. A live owner or future deadline is an expected skip. See [terminal test fixtures](../docs/terminal-test-fixtures.md) for ownership, capture and cleanup limits.

### Legacy registered tmux tasks

This adapter remains for old task records during cutover. New terminal fixtures use the private Rex driver.

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

Run the isolated fixture tests and live integration:

```sh
node scripts/test-reap-strays.mjs
node scripts/test-reaper-live.mjs
zsh -n macos/.local/bin/reap-strays zsh/.zsh_config/funcs_strays.zsh
plutil -lint macos/Library/LaunchAgents/com.luisaceituno.reap-strays.plist
```

Unit fixtures inject process reads, time, signals, files, and tmux calls. They cover login-only shells, ambiguous bundle paths, lock initialization failures, concurrent lock changes, backward clocks, failed signals, and PID reuse. They never signal real processes or kill real sessions.

Live terminal cleanup uses a private Rex endpoint. It preserves expired tasks while their owner is alive, then removes only registered test children after the owner and supervisor exit. The suite includes a child that resists HUP and TERM. Bootstrap and deadline checks are separate tests. These checks do not change the installed watchdog.

BSD `ps` exposes start time only to the second. The last read narrows races but cannot remove the small interval between verification and a signal. Ambiguous input fails closed. An unhandled crash or unreadable cleanup metadata can still leave a lock for manual recovery.

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
