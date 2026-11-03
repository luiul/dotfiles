# karabiner

Karabiner-Elements rewrites `~/.config/karabiner/karabiner.json` whenever its settings change.
This replaces any stow symlink with a real file.
This package is **not stowable**.
It keeps `karabiner.json` as a versioned export, like the `rectangle` package.

## Super key

Caps Lock maps to Command, Control, Option, and Shift.

## VS Code shortcut

`cmd+e` calls `~/.local/bin/ghostty-open-vscode` when Ghostty is frontmost.
It opens the focused split's current directory in VS Code, or focuses its existing window.
It uses the exact directory, not the git repo root, and works at a shell prompt or inside Pi.
Stow the `ghostty` package to install the helper, then restore the Karabiner config below.
Run `uv run scripts/test-ghostty-open-vscode.py` to check the shortcut and helper.
Add `--live` to test a temporary Ghostty split and an isolated VS Code window.

## Restore on a new machine

```sh
mkdir -p ~/.config/karabiner
cp ~/dotfiles/karabiner/karabiner.json ~/.config/karabiner/karabiner.json
```

Then open Karabiner-Elements so it picks up the config.

## Update the snapshot

After changing settings in Karabiner-Elements, refresh the tracked copy:

```sh
cp ~/.config/karabiner/karabiner.json ~/dotfiles/karabiner/karabiner.json
```

and commit.

## Why no `stow karabiner`

`setup.sh` skips this package because Karabiner would replace the symlink on its next config write.
The file is tracked here only as a versioned export.
