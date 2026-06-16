# claudenotifier

`ClaudeNotifier.app` is a tiny macOS notification helper that backs Claude
Code's hook notifications (`claude/.claude/notify.sh`). It exists so that
**clicking a notification banner focuses the terminal that launched Claude**.

## Why a dedicated app

A macOS notification's click is delivered to the app that *posted* it.
`osascript display notification` posts as Script Editor, so a click can only
ever activate Script Editor, never your terminal. The maintained CLI tools that
could do this (`alerter`, `terminal-notifier`) are broken on current macOS or
unmaintained. So we post from our own minimal app instead.

`alerter` specifically relies on the legacy `NSUserNotification` API, which
macOS 26.x accepts without error but silently never delivers.

## How it works

`notify.sh` detects the terminal from `$TERM_PROGRAM`, maps it to a bundle id,
and hands the message + target to the app through a tab-separated "pending" file
in `$TMPDIR` (a compiled applet does not receive command-line argv). It then
launches the app:

- **Pending file present** -> POST: the app reads it, stores the target bundle
  id, posts the banner, deletes the pending file, exits.
- **No pending file** (the click relaunch) -> FOCUS: the app reads the stored
  bundle id and runs `open -b <bundleId>` to raise that terminal.

If the app is missing, `notify.sh` falls back to a plain `osascript` banner (no
click-to-focus), so notifications never silently break.

## Why this package is not stowed

Like `rectangle`, this package is **not** symlinked into `$HOME`. It holds build
*source* (`ClaudeNotifier.applescript`, `icon.icns`), not dotfiles. `setup.sh`
builds the source into `~/Applications/ClaudeNotifier.app` and skips this
package in the stow loop.

## Build

`setup.sh` does this automatically. To rebuild by hand:

```sh
osacompile -o ~/Applications/ClaudeNotifier.app \
  claudenotifier/ClaudeNotifier.applescript
```

`setup.sh` additionally patches the bundle identity (`CFBundleIdentifier`,
`CFBundleName`/`CFBundleDisplayName` = "Claude Code"), installs `icon.icns` as
the app icon, ad-hoc signs, and re-registers with Launch Services so the banner
shows the right name and icon.

## First-run permission

The first time the app posts, macOS registers it but may suppress the banner
until you allow it. Open **System Settings -> Notifications -> Claude Code**,
turn on **Allow Notifications**, and set the style to **Banners** (or Alerts).

## Updating the icon

`icon.icns` is a checked-in build artifact. To regenerate, produce a 1024x1024
PNG, then:

```sh
mkdir Claude.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out Claude.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon-1024.png --out Claude.iconset/icon_${s}x${s}@2x.png
done
cp icon-1024.png Claude.iconset/icon_512x512@2x.png
iconutil -c icns Claude.iconset -o claudenotifier/icon.icns
```
