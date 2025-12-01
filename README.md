# My Dotfiles

This repository contains my dotfiles. I use [GNU Stow](https://www.gnu.org/software/stow/) for managing them. The naming convention for GNU Stow is explained in this video: [GNU Stow Naming Convention](https://youtu.be/NoFiYOqnC4o?si=SlQi1YkUaC4GziYH&t=520).

## Applying Changes with Stow

GNU Stow manages your dotfiles by creating symlinks in your home directory.
Below is a reliable workflow for stowing, updating, and resolving conflicts safely.

### Apply or Update All Dotfiles

From the root of this repository:

```sh
stow .
```

This will (re)symlink all directories into your `$HOME` according to their internal folder structure.

### Stow a Single Configuration Folder

```sh
stow <folder>
```

Replace `<folder>` with the name of the folder you want to stow (e.g., `zsh`, `karabiner`, `vscode`, etc.).

### Remove Symlinks (Unstow)

To remove symlinks created by Stow:

```sh
stow -D <folder>
```

### Handling Conflicts

If Stow warns that a file already exists and is **not** a symlink (e.g., Karabiner, VSCode settings, etc.), you have two options:

#### Option 1 — Adopt Existing Files into Your Dotfiles Repo

```sh
stow --adopt <folder>
```

This moves existing files on your system into your dotfiles repo and replaces them with symlinks.

#### Option 2 — Manually Remove or Back Up the Conflicting File

If you prefer to keep the existing file as a backup:

```sh
mv ~/.config/<path>/<file> ~/.config/<path>/<file>.backup
stow <folder>
```

### Tips

- Always run Stow **from the root** of the dotfiles repository.
- Each top-level folder (e.g., `zsh/`, `karabiner/`, `vscode/`) should mirror your `$HOME` structure inside it.

## Homebrew

Use `brew bundle dump --file=brew/Brewfile --force` to keep the Brewfile updated. To restore the Brewfile, use `brew bundle --file=brew/Brewfile`.
