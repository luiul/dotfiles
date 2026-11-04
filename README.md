# My Dotfiles

This repository contains my dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Clone to `~/dotfiles`.

## Quick Start

```sh
./setup.sh
```

The script is idempotent and prompts before each step. It will:

1. Install Homebrew and Brewfile packages
2. Install global npm packages listed in the Brewfile
3. Install `znap` (zsh plugin manager)
4. Stow all dotfile packages into `$HOME` (skips export-only packages and non-package dirs, see below)
5. Generate an ed25519 SSH key (if missing) and add it to the macOS Keychain
6. Clean stale `.zwc` files, configure git hooks, and create `.env` from `example.env`

## Stow Packages

Each top-level directory is a stow package that mirrors `$HOME`:

`aws`, `borders`, `brew`, `canopy`, `datagrip`, `ghostty`, `git`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zsh`

Four packages are tracked but **not stowed** (export-only, see below): `karabiner`, `rectangle`, `datagrip`, and `snapzy`.

One package is stowed only in part: `macos` stows `Library/LaunchAgents/` normally but excludes
`Library/LaunchDaemons/` (system-wide, no per-user path stow can target correctly) — see
`macos/README.md` for manual install of the LaunchDaemon.

### Apply or Update All

Run `./setup.sh` to apply or update all stow packages.
Its Stow step owns the package exclusions and directory setup.

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

## Snapzy

Snapzy rewrites `~/.config/snapzy/config.toml` with atomic saves (write temp + rename, `atomically: true` in `SnapzyConfigurationService.swift`), which would replace a stow symlink with a real file on every settings sync. The `snapzy` package is therefore a tracked snapshot, not stowed. Restore or refresh the snapshot with the `cp` commands in `snapzy/README.md`.

## AWS

The `aws` package stows `~/.aws/config` (used by the `aws-sso-refresh` pi extension via `AWS_PROFILE=sso-bedrock`). The real `aws/.aws/config` is gitignored because it contains an AWS account ID and the corporate SSO portal URL; only `aws/.aws/config.example` (placeholders) is tracked. On a fresh machine, copy the example to `aws/.aws/config`, fill in real values, then stow. See `aws/README.md`.

## VS Code

The `vscode` package stows `settings.json`, `keybindings.json`, and `extensions.json` (recommendations) into `~/Library/Application Support/Code/User/`. Installed extensions are tracked as `vscode` entries in the Brewfile, which the pre-commit hook regenerates from the live system, so uninstalling an extension locally drops it from the Brewfile on the next commit. Extensions removed in the 2026-08-31 performance prune (with reinstall commands) and the performance-tuned settings are documented in `vscode/README.md`. The convention for sharing draw.io diagrams in GitHub READMEs (single-file `.drawio.svg` under `docs/diagrams/`, editable in VS Code) is documented in `docs/diagrams.md`.

## Pi Memory (Hermes)

`pi-hermes-memory` uses direct review calls through `ai-model-router/GLM 5.3 Flash`, with `ai-model-router/GPT-6 Luna` as its fallback. Thinking stays off for background maintenance. The config lives at `pi/.pi/agent/hermes-memory-config.json`, stowed to `~/.pi/agent/hermes-memory-config.json`. Model references use current router IDs, not retired technical IDs.

The AWS SSO refresh extension remains available to isolated child calls. Review transport and fallback settings do not change the main session model or its prompt cache.

## Pi Subagents

`pi/.pi/agent/agents/Explore.md` overrides the built-in Explore helper from [pi-subagents](https://github.com/tintinweb/pi-subagents). It uses `ai-model-router/GPT-6 Luna` with low thinking for narrow read-only file and symbol searches. General-purpose and Plan inherit the main session model, now `GPT-6.1 Terra` with high thinking. Delegate independent lookups, not the main decision or duplicate work. A manual model override is available for difficult tasks.

The helper excludes `canopy-status`, since SDK subagents share their parent's process ID and must not publish its dashboard status. The [Canopy extension](https://github.com/luiul/canopy/blob/main/extensions/canopy-status.ts) also accepts only interactive sessions. Apply the helper with `stow --no-folding pi`.

## Pi Model Picker

The global picker opens with six scoped favorites. New sessions start on router Terra high. The apartment project inherits the same scope but keeps Argon high as its visual-task default. Resumed sessions retain their saved model.

Roles are short display names on existing model records. Pi shows each role and purpose beside the canonical model ID. They add no provider, extension, request, duplicate ID, or ranking system. Open `/model` or press `Ctrl+L`, then type a model or role. Tab switches between scoped favorites and all authenticated models. `/thinking` or `Shift+Tab` changes effort without changing model.

| Model | Role | Use | Startup effort |
| --- | --- | --- | --- |
| Router GPT-6.1 Terra | Daily | Coding and admin | High |
| Router GPT-6.1 Sol | Think | Hard problems and advice | Medium |
| Router GLM 5.3 | Budget | Lower-cost coding | High |
| Router GPT-6 Luna | Quick | Lookups and simple tasks | Low |
| Vertex Gemini 4 Argon | Vision | Images, scans and floorplans | High |
| Router GLM 5.3 Flash | Helper | Summaries and memory checks | Off |

Terra is the chosen GPT-style daily model, not a claim of lower cost on every task. GLM remains the measured budget alternative. Sol is manual escalation, and Luna is for bounded work. Helper is not a deep code reviewer. Kimi, Claude and other specialists remain under Tab → all. Use exact provider/model IDs to select a specific route. If editor autocomplete expands a filter before submission, press Escape before Enter.

Grove owns router display names through its `overlay.json`. The Vertex name is a `modelOverrides` entry. Keep canonical IDs in settings and worker config. Direct Bedrock Sonnet remains a manual independent reviewer, not an automatic extra call. See [model value checks](docs/pi-model-value.md) for matched costs, acceptance checks, and limits.

## Pi Web Search

`pi/.pi/agent/web-search.json` keeps the normal workflow at `none`, so search adds no automatic summary model call. Provider selection and fallback stay automatic. Explicit summary workflows use `GLM 5.3 Flash:off`; curator query rewriting uses `GPT-6 Luna:low`. Preserve source prices, dates, versions, and URLs. Do not send private project details to public search.

A configured summary failure uses the package's deterministic fallback. Search evidence and final task decisions remain with the main agent.

## Agent Commands

Custom slash commands live in `pi/.pi/agent/prompts/`. These Pi prompt templates are symlinked to `~/.pi/agent/prompts/` and load in the next Pi session.

- `/proofread <message> [--context <text>] [--scratch] [--no-copy]` (pi only): proofreads and polishes a message in ASD-STE100 style and copies the final version to the clipboard. `--context`/`-c` marks everything after it as context only (e.g. a pasted Slack thread), never rewritten. `--no-copy`/`-n` skips the clipboard step. `--scratch`/`-s` also saves the full review to `~/scratch/`. Flags combine freely and work as trailing tokens: `/proofread lgtm, ship it --context <thread> -s`.
- `/scratch <what to write>`: writes text output to `~/scratch/<descriptive-name>.md`, prints the absolute path, and shows the content in chat. Example: `/scratch write a short summary of the incident timeline`.

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

## `upgrade-tools`

The `upgrade-tools` shell function (defined in `zsh/.zsh_config/funcs.zsh`) upgrades everything in one go: Homebrew, `uv` tools, and npm globals. Missing tools are skipped rather than failing. Pass `--check` (or `-c`) for a dry-run preview of what is outdated.

## Pre-commit Hook

The pre-commit hook generates `example.env` from `.env` (keys only), updates the Brewfile, and blocks `.env` from being committed. It excludes retired Claude CLI model defaults, ClaudeNotifier, and the Claude Code VS Code extension from these snapshots. It runs [gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks protect --staged`) to scan staged changes for secrets. Bypass with `--no-verify` for false positives.

Pi agent activity is shown in Orca and Canopy. Pi desktop notifications and Claude Code configs are no longer part of this setup.

Verification from the repository root:

```sh
bun scripts/test-retired-claude-config.ts
```
