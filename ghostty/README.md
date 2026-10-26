# Ghostty

## Shortcuts

Karabiner calls the helpers in this stow package directly. Raycast is not needed.

- `cmd+shift+c` marks the current Ghostty tab as the command center and clears any previous designation.
- `super+c` (Caps Lock + C) focuses the command center from any app, or creates one at `$HOME` if none exists.
- `cmd+shift+x` clears the current tab's designation.
- `cmd+e` opens the focused split's current directory in VS Code, or focuses its existing window.

The command center uses the locked title `🎛 cc`.
It overrides shell title changes and covers every split in the tab.
The helper searches all tabs, so switching tabs does not hide the command center.
Closing the marked tab removes its designation.

## Setup

1. Run `stow ghostty` from `~/dotfiles` to install the config and both helpers.
2. Restore `karabiner/karabiner.json` as described in `karabiner/README.md`.
3. Allow Ghostty automation for Karabiner when macOS asks.

For an existing Raycast setup, remove the old "Focus Command Center" script and its hotkey.
The old script lived at `~/.config/raycast/scripts/cc.sh`.
Keep Raycast installed if you use it for other tasks.

## Helpers

`ghostty-cc mark` marks the selected tab of Ghostty's front window.
`ghostty-cc` focuses the marked tab or creates one when missing.
Both actions use Ghostty's AppleScript dictionary, not keystrokes or the accessibility window list.
A process lock serializes calls to prevent duplicate windows.
Each successful call writes `marked`, `focused`, or `opened` to `~/.cache/cc.log`.

`ghostty-open-vscode` reads the focused split's current directory from Ghostty.
It uses that exact local directory, not the git repo root.
It works at a shell prompt and inside Pi.

## Tests

- `uv run scripts/test-cc.py` checks both cc mappings, helper errors, and concurrent calls.
- `uv run scripts/test-cc.py --live` also tests temporary windows in the running Ghostty app.
- `uv run scripts/test-ghostty-open-vscode.py --live` tests a temporary split and an isolated VS Code window.

Live tests restore the original cc designation and focus, and close their temporary windows.
Do not switch apps or tabs while these tests run.
Config checks cannot prove Karabiner's hardware-key handling. Press each physical shortcut once after setup.
