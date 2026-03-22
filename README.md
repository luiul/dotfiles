# My Dotfiles

This repository contains my dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Clone to `~/dotfiles`.

## Quick Start

```sh
./setup.sh
```

This will:

1. Install Homebrew (if missing) and packages from the Brewfile
2. Stow all dotfile packages into `$HOME`
3. Install the pre-commit hook (secret detection)
4. Register launchd agents (weekly Brewfile dump)

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`borders`, `brew`, `claude`, `ghostty`, `karabiner`, `pip`, `pylint`, `rectangle`, `ruff`, `sqlfluff`, `vscode`, `zsh`

Non-stow directories: `cron` (launch agents and scheduled scripts)

### Apply or Update All

```sh
stow --ignore='^cron$' */
```

### Stow a Single Package

```sh
stow <package>
```

### Remove Symlinks

```sh
stow -D */        # all packages
stow -D <package> # single package
```

### Handling Conflicts

If Stow warns a file already exists and is not a symlink:

```sh
# Option 1: adopt existing files into the repo
stow --adopt */

# Option 2: back up and re-stow
mv ~/.config/<path>/<file> ~/.config/<path>/<file>.backup
stow <package>
```

## Homebrew

The Brewfile is automatically updated weekly via a launchd agent (`cron/com.dotfiles.brew-dump.plist`). To manually update:

```sh
brew bundle dump --file=brew/Brewfile --force
```

To restore packages from the Brewfile:

```sh
brew bundle --file=brew/Brewfile
```

## Pre-commit Hook

A secret detection hook scans staged diffs for API keys, tokens, and private keys. Bypass with `--no-verify` for false positives.
