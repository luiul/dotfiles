# My Dotfiles

This repository contains my dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Clone to `~/dotfiles`.

## Quick Start

```sh
./setup.sh
```

The script is idempotent and prompts before each step. It will:

1. Install Homebrew and Brewfile packages
2. Install global npm packages listed in the Brewfile
3. Install Claude Code (native build), register plugin marketplaces, and install plugins
4. Install `alerter` (notification helper) and `znap` (zsh plugin manager)
5. Stow all dotfile packages into `$HOME`
6. Clean stale `.zwc` files, configure git hooks, and create `.env` from `example.env`

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`borders`, `brew`, `claude`, `ghostty`, `git`, `hellofresh`, `karabiner`, `pip`, `rectangle`, `ruff`, `snowflake`, `sqlfluff`, `stow`, `streamlit`, `vscode`, `zsh`

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

| Directive | What it installs                     |
| --------- | ------------------------------------ |
| `tap`     | Homebrew taps                        |
| `brew`    | Formulae                             |
| `cask`    | GUI apps                             |
| `vscode`  | VS Code extensions                   |
| `uv`      | Python tools (via `uv tool install`) |

The Brewfile also contains `npm` entries for global Node.js packages. These are ignored by `brew bundle` and installed by `setup.sh` via `npm install -g`. The pre-commit hook auto-detects installed npm global packages and appends them to the Brewfile on each commit.

To manually update the Brewfile:

```sh
brew bundle dump --file=brew/Brewfile --force
```

To restore packages from the Brewfile:

```sh
brew bundle --file=brew/Brewfile
grep '^npm ' brew/Brewfile | sed 's/^npm "\(.*\)"/\1/' | xargs -I{} npm install -g {}
```

## Claude Code Skills

Skills are installed globally via [`npx skills`](https://github.com/mattpocock/skills):

```sh
npx skills@latest add -g <source>
```

The `Skillfile` tracks installed skills and is automatically updated on every commit via the pre-commit hook.

## Claude Code Plugins

Claude Code itself is installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) and self-updates with `claude update`. Plugins are managed through `claude plugin install|update|list` and live inside registered marketplaces.

Two files track this state, both auto-updated on every commit via the pre-commit hook:

| File              | Format                            | Purpose                                                       |
| ----------------- | --------------------------------- | ------------------------------------------------------------- |
| `Marketplacefile` | `<name> <owner/repo>` per line    | Marketplaces to register with `claude plugin marketplace add` |
| `Pluginfile`      | `<plugin>@<marketplace>` per line | Plugins to install with `claude plugin install`               |

On a fresh machine, `setup.sh` first registers marketplaces, then installs plugins. `upgrade-tools` refreshes marketplace indices and updates each installed plugin.

## `upgrade-tools`

The `upgrade-tools` shell function (defined in `zsh/.zsh_config/funcs.zsh`) upgrades everything in one go: Homebrew, `uv` tools, npm globals, Claude Code, Claude plugins, and Claude skills. Missing tools are skipped rather than failing.

## Pre-commit Hook

The pre-commit hook auto-generates `example.env` from `.env` (keys only), updates the Brewfile, Skillfile, Marketplacefile, and Pluginfile, blocks `.env` from being committed, and scans staged diffs for API keys, tokens, and private keys. Bypass with `--no-verify` for false positives.
