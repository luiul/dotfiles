# rectangle

Rectangle stores its config in macOS defaults (`com.knollsoft.Rectangle`), not
in a home-directory file. Stow cannot manage it — `RectangleConfig.json` is an
exported snapshot kept here for restore-on-fresh-machine.

## Restore on a new machine

1. Install Rectangle: `brew install --cask rectangle` (in `Brewfile`).
2. Open Rectangle → Preferences → "Import" and select
   `~/dotfiles/rectangle/RectangleConfig.json`.

## Update the snapshot

Rectangle → Preferences → "Export" → overwrite
`~/dotfiles/rectangle/RectangleConfig.json` and commit.

## Why no `stow rectangle`

The package is intentionally not stowable — there's nothing to symlink. It's
tracked here purely as a versioned export.
