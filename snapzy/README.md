# snapzy

Snapzy writes `~/.config/snapzy/config.toml` atomically (write temp + rename,
`atomically: true` in `SnapzyConfigurationService.swift`) whenever its settings
sync, which silently replaces any stow symlink with a real file. Because of
that, this package is **not stowable**: `config.toml` is kept here as a
versioned export, the same way the `karabiner` and `datagrip` packages work.

## Restore on a new machine

```sh
mkdir -p ~/.config/snapzy
cp ~/dotfiles/snapzy/config.toml ~/.config/snapzy/config.toml
```

Then launch Snapzy so it applies the config at startup.

## Update the snapshot

After changing settings in Snapzy, refresh the tracked copy:

```sh
cp ~/.config/snapzy/config.toml ~/dotfiles/snapzy/config.toml
```

and commit.

## Why no `stow snapzy`

`setup.sh` skips this package, and it is excluded from the stow list because
Snapzy would overwrite the symlink with a real file on its next config sync.
It is tracked here purely as a versioned export.
