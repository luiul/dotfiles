# karabiner

Karabiner-Elements rewrites `~/.config/karabiner/karabiner.json` in place
(reformatting it) whenever its settings change, which silently replaces any
stow symlink with a real file. Because of that, this package is **not
stowable** — `karabiner.json` is kept here as a versioned export, the same way
the `rectangle` package works.

## Command center shortcut

`cmd+shift+c` calls `~/.config/raycast/scripts/cc.sh mark` when Ghostty is frontmost.
It marks the current tab and clears any previous command center designation.
Caps Lock remains the `super` modifier, with `super+c` handled by Raycast.
See `raycast/README.md` for setup and tests.

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

`setup.sh` skips this package, and it is excluded from the stow list because
Karabiner would immediately overwrite the symlink with a real file on its next
config write. It is tracked here purely as a versioned export.
