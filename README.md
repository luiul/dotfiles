# My Dotfiles

This repository contains my dotfiles. I use [GNU Stow](https://www.gnu.org/software/stow/) for managing them. The naming convention for GNU Stow is explained in this video: [GNU Stow Naming Convention](https://youtu.be/NoFiYOqnC4o?si=SlQi1YkUaC4GziYH&t=520).

## Applying Changes with Stow

After modifying any dotfile, run the following command from the root of this repository to (re)symlink all managed dotfiles into your home directory:

```sh
stow .
```

This will create symlinks for each directory into your `$HOME` directory. If you want to stow only a specific folder (for example, just your Zsh config), use:

```sh
stow zsh
```

If you need to remove symlinks created by Stow (unstow), run:

```sh
stow -D <folder>
```

## Homebrew

Use `brew bundle dump --file=brew/Brewfile --force` to keep the Brewfile updated.  
To restore the Brewfile, use `brew bundle --file=brew/Brewfile`.
