# Raycast

One script command: `cc.sh`, "Focus Command Center".

## Shortcuts

- `cmd+shift+c` marks the current Ghostty tab as the command center and clears any previous designation.
- `super+c` (Caps Lock + C) focuses the command center, or creates one at `$HOME` if none exists.
- `cmd+shift+x` clears the current tab's designation.

The locked title `🎛 cc` overrides shell title changes and covers every split in the tab.
The script searches all tabs, so switching tabs does not hide the command center.
Closing the marked tab removes its designation.

## One-time setup

1. Add `~/.config/raycast/scripts` in Raycast Settings, Extensions, Script Commands.
2. Assign `⌃⌥⌘⇧C` to "Focus Command Center". Karabiner maps Caps Lock to these modifiers.
3. Restore the config from the `karabiner` package. Its Ghostty-only `cmd+shift+c` rule calls `cc.sh mark`.
4. Allow Ghostty automation for Raycast and Karabiner when macOS asks.

## Implementation

One script handles marking and focusing through Ghostty's AppleScript dictionary.
It does not send keystrokes or query the accessibility window list.
A process lock serializes shortcut presses to prevent duplicate windows.
Each successful call writes `marked`, `focused`, or `opened` to `~/.cache/cc.log`.
Errors show a notification instead of opening another window.

Run `uv run scripts/test-cc.py` for script and binding checks.
Run `uv run scripts/test-cc.py --live` to also test temporary windows in the running Ghostty app.
