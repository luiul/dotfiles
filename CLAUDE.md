# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `borders`, `brew`, `claude`, `ghostty`, `git`, `karabiner`, `pip`, `rectangle`, `ruff`, `sqlfluff`, `vscode`, `zsh`

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## Workflow

- Commit directly to `main` (no branches/PRs for this repo)
- Commit messages: conventional commits (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
