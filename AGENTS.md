# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `aws`, `borders`, `brew`, `claude`, `datagrip`, `ghostty`, `git`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zed`, `zsh` (`docs/` and `node_modules/` are not packages)

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## Workflow

- Leave changes unstaged in the working tree until the user approves them; they review with VS Code's "Open Changes" diff view.
- After approval: stage, commit on `main`, and push straight to `origin/main`. No feature branches or pull requests for this repo (same as other personal projects; HelloFresh repos require pull requests).
- Conventional commit messages (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
