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
5. Stow all dotfile packages into `$HOME` (skips export-only packages and non-package dirs — see below)
6. Generate an ed25519 SSH key (if missing) and add it to the macOS Keychain
7. Clean stale `.zwc` files, configure git hooks, and create `.env` from `example.env`

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`aws`, `borders`, `brew`, `claude`, `datagrip`, `ghostty`, `git`, `hellofresh`, `herdr`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rtk`, `ruff`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zed`, `zsh`

Three packages are tracked but **not stowed** (export-only, see below): `karabiner`, `rectangle`, and `datagrip`.

One package is stowed only in part: `macos` stows `Library/LaunchAgents/` normally but excludes
`Library/LaunchDaemons/` (system-wide, no per-user path stow can target correctly) — see
`macos/README.md` for manual install of the LaunchDaemon.

### Apply or Update All

`./setup.sh` does this, or mirror its skip list by hand:

```sh
for pkg in */; do
	case "${pkg%/}" in
		rectangle | karabiner | datagrip | docs | scripts) continue ;;
	esac
	stow --no-folding "${pkg%/}"
done
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

## macOS system tweaks

The `macos` package holds per-user LaunchAgents (stowed) and system-wide LaunchDaemons (not
stowable, manual install). Currently includes a LaunchDaemon that keeps AWDL (AirDrop/AirPlay/
Sidecar radio) disabled, fixing a Zscaler ZPA tunnel-drop issue caused by AWDL's periodic Wi-Fi
channel hops. See `macos/README.md`.

## Karabiner

Karabiner-Elements rewrites `~/.config/karabiner/karabiner.json` in place whenever its settings change, which silently replaces a stow symlink with a real file. The `karabiner` package is therefore not stowable — `karabiner.json` is kept as a versioned export and `setup.sh` skips it. Restore by copying it into `~/.config/karabiner/`. See `karabiner/README.md`.

## DataGrip

JetBrains IDEs rewrite config files with atomic saves (write temp + rename), which would replace a stow symlink with a real file on the first edit in the UI. The `datagrip` package is therefore a tracked snapshot, not stowed: the four data sources (Snowflake, the Databricks query engine, and the two global-ops Databricks connections) plus their introspection scopes. Passwords and OAuth tokens live in the macOS keychain, never in the XML. Restore or refresh the snapshot with the `cp` commands in `datagrip/README.md`.

## Claude Code settings

Claude Code rewrites `~/.claude/settings.json` in place at runtime (managed hooks), like Karabiner. So `claude/.claude/settings.json` is a tracked snapshot, not stowed: a `.stow-local-ignore` in the `claude` package keeps stow from linking it, while `CLAUDE.md` in the same package is still symlinked. Refresh the snapshot with `cp ~/.claude/settings.json claude/.claude/settings.json`.

## AWS

The `aws` package stows `~/.aws/config` (used by the `aws-sso-refresh` pi extension via `AWS_PROFILE=sso-bedrock`). The real `aws/.aws/config` is gitignored because it contains an AWS account ID and the corporate SSO portal URL; only `aws/.aws/config.example` (placeholders) is tracked. On a fresh machine, copy the example to `aws/.aws/config`, fill in real values, then stow. See `aws/README.md`.

## VS Code

The `vscode` package stows `settings.json`, `keybindings.json`, and `extensions.json` (recommendations) into `~/Library/Application Support/Code/User/`. Installed extensions are tracked as `vscode` entries in the Brewfile, which the pre-commit hook regenerates from the live system, so uninstalling an extension locally drops it from the Brewfile on the next commit. Extensions removed in the 2026-08-31 performance prune (with reinstall commands) and the performance-tuned settings are documented in `vscode/README.md`. The convention for sharing draw.io diagrams in GitHub READMEs (single-file `.drawio.svg` under `docs/diagrams/`, editable in VS Code) is documented in `docs/diagrams.md`.

## Pi Memory (Hermes)

`pi-hermes-memory`'s background auto-review LLM calls are configured via `pi/.pi/agent/hermes-memory-config.json` (stowed to `~/.pi/agent/hermes-memory-config.json`). Since pi's only configured provider is `amazon-bedrock` authenticated via ambient AWS SSO (`AWS_PROFILE=sso-bedrock`, no `/login`-stored API key), the extension's in-process "Direct" review transport always fails (`no_auth: No API key for amazon-bedrock` — its auth resolver only recognizes a persisted API-key credential), falling through to a "Subprocess" transport that spawns an isolated `pi -p --no-extensions` child. That child previously had no path to the `aws-sso-refresh` extension (stripped by `--no-extensions`), so a stale SSO token at review time could hang the child until pi's hard 120s kill fired ("Memory auto-review failed in both transports ... child timed out after 120000ms").

Fix applied: `reviewTransport: "subprocess"` (skip the always-doomed Direct attempt), `llmModelOverride` to a cheap/fast Bedrock model for background maintenance calls, and `childExtensionPaths` pointing at `aws-sso-refresh.ts` so the isolated child process also proactively refreshes the SSO session before its model call, instead of relying on whatever state the token happened to be in.

**Next step (not yet done, needs a manual interactive command):** run `/login amazon-bedrock` inside pi to store a persisted Bedrock API key (bearer token) in `auth.json`, if the `bedrock-user` SSO role permits minting one. That would let the Direct transport succeed in-process on its own, removing the Subprocess/SSO-refresh dependency for memory review entirely rather than just mitigating it.

## Agent Commands

Custom slash commands live in `pi/.pi/agent/prompts/` (pi prompt templates, symlinked to `~/.pi/agent/prompts/`, picked up on the next pi session) and `claude/.claude/commands/` (Claude Code parity).

- `/proofread <message> [--context <text>] [--scratch] [--no-copy]` (pi only): proofreads and polishes a message in ASD-STE100 style and copies the final version to the clipboard. `--context`/`-c` marks everything after it as context only (e.g. a pasted Slack thread), never rewritten. `--no-copy`/`-n` skips the clipboard step. `--scratch`/`-s` also saves the full review to `~/scratch/`. Flags combine freely and work as trailing tokens: `/proofread lgtm, ship it --context <thread> -s`.
- `/scratch <what to write>` (pi and Claude Code): writes text output to `~/scratch/<descriptive-name>.md`, prints the absolute path, and shows the content in chat. Example: `/scratch write a short summary of the incident timeline`.

Scratch files are opt-in everywhere (see the "Scratch Files" section in `pi/.pi/agent/AGENTS.md`): no tool writes to `~/scratch/` unless a command flag above says so, or the prompt contains the `scratch:` trigger.

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

On a fresh machine, `setup.sh` first registers marketplaces, then installs plugins. Marketplace/plugin updates are handled by Claude Code itself, not by `upgrade-tools`.

## `upgrade-tools`

The `upgrade-tools` shell function (defined in `zsh/.zsh_config/funcs.zsh`) upgrades everything in one go: Homebrew, `uv` tools, and npm globals. Missing tools are skipped rather than failing. Pass `--check` (or `-c`) for a dry-run preview of what is outdated.

## Pre-commit Hook

The pre-commit hook auto-generates `example.env` from `.env` (keys only), updates the Brewfile, Marketplacefile, and Pluginfile, blocks `.env` from being committed, and runs [gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks protect --staged`) to scan staged changes for secrets. Bypass with `--no-verify` for false positives.
