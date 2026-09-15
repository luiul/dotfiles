# macos

System-level macOS tweaks that don't fit any single app's package. Two parts:

- `Library/LaunchAgents/` — per-user agents, stowed normally to `~/Library/LaunchAgents/`.
- `Library/LaunchDaemons/` — system-wide daemons. These load from `/Library/LaunchDaemons/`,
  which has no per-user equivalent, so `stow macos` would otherwise create a dead symlink at
  `~/Library/LaunchDaemons` (macOS never reads that path for daemons). A `.stow-local-ignore`
  excludes `Library/LaunchDaemons` from the stow run; install these manually (below).

## `com.luisaceituno.gui-env` (LaunchAgent, stowed)

Runs `~/.local/bin/gui-env-sync.sh` at login to push selected secrets from `~/dotfiles/.env`
into the GUI session environment via `launchctl setenv`, so Dock-launched apps (e.g. Zed) see
them at process start. See the script's own header comment for the full "why".

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
