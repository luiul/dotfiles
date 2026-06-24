# karabiner

Karabiner-Elements rewrites `~/.config/karabiner/karabiner.json` in place
(reformatting it) whenever its settings change, which silently replaces any
stow symlink with a real file. Because of that, this package is **not
stowable** — `karabiner.json` is kept here as a versioned export, the same way
the `rectangle` package works.

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
