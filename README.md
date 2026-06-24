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
4. Install `znap` (zsh plugin manager)
5. Build `ClaudeNotifier.app` into `~/Applications` (click-to-focus notification helper — see `claudenotifier/`)
6. Stow all dotfile packages into `$HOME` (skips `rectangle` and `claudenotifier` — see below)
7. Generate an ed25519 SSH key (if missing) and add it to the macOS Keychain
8. Clean stale `.zwc` files, configure git hooks, and create `.env` from `example.env`

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`aws`, `borders`, `brew`, `claude`, `claudenotifier`, `ghostty`, `git`, `hellofresh`, `pip`, `rectangle`, `ruff`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `zsh`

Two packages are tracked but **not stowed** (export-only, see below): `karabiner` and `rectangle`.

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

## SSH

The `ssh` package stows only `~/.ssh/config` (private keys never leave `~/.ssh/`). The config enables `UseKeychain yes` + `AddKeysToAgent yes` so the passphrase is cached in the macOS login Keychain — entered once, reused across reboots via the system launchd `ssh-agent`. `setup.sh` handles fresh-machine bootstrap (keygen + `ssh-add --apple-use-keychain`).

## Rectangle

Rectangle stores its config in macOS defaults, not in a home-directory file, so the `rectangle` package is not stowable. `RectangleConfig.json` is an exported snapshot — restore via Rectangle → Preferences → Import. See `rectangle/README.md`.

## Karabiner

Karabiner-Elements rewrites `~/.config/karabiner/karabiner.json` in place whenever its settings change, which silently replaces a stow symlink with a real file. The `karabiner` package is therefore not stowable — `karabiner.json` is kept as a versioned export and `setup.sh` skips it. Restore by copying it into `~/.config/karabiner/`. See `karabiner/README.md`.

## Claude Code settings

Claude Code (and Supacode) rewrite `~/.claude/settings.json` in place at runtime (managed hooks), like Karabiner. So `claude/.claude/settings.json` is a tracked snapshot, not stowed: a `.stow-local-ignore` in the `claude` package keeps stow from linking it, while `CLAUDE.md` in the same package is still symlinked. Refresh the snapshot with `cp ~/.claude/settings.json claude/.claude/settings.json`.

## AWS

The `aws` package stows `~/.aws/config` (used by the `aws-sso-refresh` pi extension via `AWS_PROFILE=sso-bedrock`). The real `aws/.aws/config` is gitignored because it contains an AWS account ID and the corporate SSO portal URL; only `aws/.aws/config.example` (placeholders) is tracked. On a fresh machine, copy the example to `aws/.aws/config`, fill in real values, then stow. See `aws/README.md`.

## ClaudeNotifier

The `claudenotifier` package is build source, not a dotfile, so it is not stowable. `setup.sh` builds `ClaudeNotifier.applescript` into `~/Applications/ClaudeNotifier.app`, a tiny notification helper so that clicking a Claude Code notification focuses the originating terminal. On first run, enable it in System Settings → Notifications → Claude Code. See `claudenotifier/README.md`.

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

## Claude Code Plugins

Claude Code itself is installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) and self-updates with `claude update`. Plugins are managed through `claude plugin install|update|list` and live inside registered marketplaces.

Two files track this state, both auto-updated on every commit via the pre-commit hook:

| File              | Format                            | Purpose                                                       |
| ----------------- | --------------------------------- | ------------------------------------------------------------- |
| `Marketplacefile` | `<name> <owner/repo>` per line    | Marketplaces to register with `claude plugin marketplace add` |
| `Pluginfile`      | `<plugin>@<marketplace>` per line | Plugins to install with `claude plugin install`               |

On a fresh machine, `setup.sh` first registers marketplaces, then installs plugins. `upgrade-tools` refreshes marketplace indices and updates each installed plugin.

## `upgrade-tools`

The `upgrade-tools` shell function (defined in `zsh/.zsh_config/funcs.zsh`) upgrades everything in one go: Homebrew, `uv` tools, npm globals, Claude Code, and Claude plugins. Missing tools are skipped rather than failing. Pass `--check` (or `-c`) for a dry-run preview of what is outdated.

## Pre-commit Hook

The pre-commit hook auto-generates `example.env` from `.env` (keys only), updates the Brewfile, Marketplacefile, and Pluginfile, blocks `.env` from being committed, and runs [gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks protect --staged`) to scan staged changes for secrets. Bypass with `--no-verify` for false positives.
