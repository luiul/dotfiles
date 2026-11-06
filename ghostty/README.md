# Ghostty

## Shortcuts

Karabiner calls the VS Code helper in this stow package directly.

- `cmd+e` opens the focused split's current directory in VS Code, or focuses its existing window.
- `cmd+shift+x` clears a locked tab title and restores automatic titles.
- Caps Lock + R toggles the quick terminal.
- `cmd+c` copies a Ghostty selection, or passes through to the running app when there is no selection.

## Setup

1. Run `stow ghostty` from `~/dotfiles` to install the config and VS Code helper.
2. Restore `karabiner/karabiner.json` as described in `karabiner/README.md`.
3. Allow Ghostty automation for Karabiner when macOS asks.

## VS Code helper

`ghostty-open-vscode` reads the focused split's current directory from Ghostty.
It uses that exact local directory, not the git repo root.
It works at a shell prompt and inside Pi.

## Tests

- `uv run scripts/test-ghostty-open-vscode.py` checks shortcut removal, remaining bindings, directory handling, errors, and AppleScript syntax.
- `uv run scripts/test-ghostty-open-vscode.py --live` also tests a temporary split and an isolated VS Code window.

Live tests record error notifications in temporary logs instead of showing popups.
They restore focus and close their temporary windows.
Do not switch apps or tabs while these tests run.
Config checks cannot prove Karabiner's hardware-key handling.
Press each physical shortcut once after setup.
