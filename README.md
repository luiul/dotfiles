# My Dotfiles

This repository contains my dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Clone to `~/dotfiles`.

## Quick Start

```sh
./setup.sh
```

This will:

1. Install Homebrew (if missing) and packages from the Brewfile
2. Stow all dotfile packages into `$HOME`
3. Install git hooks (Brewfile dump, example.env generation, secret detection)
4. Create `.env` from `example.env` if it doesn't exist

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`borders`, `brew`, `claude`, `ghostty`, `git`, `hellofresh`, `karabiner`, `pip`, `rectangle`, `ruff`, `snowflake`, `sqlfluff`, `streamlit`, `vscode`, `zsh`

### Apply or Update All

```sh
stow */
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

## Snowflake CLI

The `snowflake` package stows `~/.snowflake/config.toml` with three connections (`default`, `staging`, `dev`) using browser SSO auth. All connection settings live in `config.toml`. The package is stowed with `--no-folding` so that Snowflake CLI runtime files (logs, cache) stay out of the repo.

## Brewfile

The Brewfile serves as a single source of truth for all packages needed on a fresh machine. It is automatically updated on every commit via the pre-commit hook.

`brew bundle` natively handles these directives:

| Directive | What it installs |
|-----------|-----------------|
| `tap` | Homebrew taps |
| `brew` | Formulae |
| `cask` | GUI apps |
| `vscode` | VS Code extensions |

The Brewfile also contains custom entries that `brew bundle` silently ignores. These are parsed and installed by `setup.sh`:

| Directive | What it installs |
|-----------|-----------------|
| `uv` | Python tools (via `uv tool install`) |
| `npm` | Node.js packages (via `npm install -g`) |

To manually update the Brewfile:

```sh
brew bundle dump --file=brew/Brewfile --force
```

To restore Homebrew packages from the Brewfile:

```sh
brew bundle --file=brew/Brewfile
```

## Claude Code Skills

Skills are installed globally via [`npx skills`](https://github.com/mattpocock/skills):

```sh
npx skills@latest add -g <source>
```

The `Skillfile` tracks installed skills and is automatically updated on every commit via the pre-commit hook.

## Pre-commit Hook

The pre-commit hook auto-generates `example.env` from `.env` (keys only), updates the Brewfile, updates the Skillfile, blocks `.env` from being committed, and scans staged diffs for API keys, tokens, and private keys. Bypass with `--no-verify` for false positives.
