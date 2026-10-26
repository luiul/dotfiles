# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `aws`, `borders`, `brew`, `datagrip`, `ghostty`, `git`, `herdr`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zsh` (`docs/` and `node_modules/` are not packages)

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## Workflow

- Leave changes unstaged in the working tree until the user approves them; they review with VS Code's "Open Changes" diff view.
- Use separate wt-managed source worktrees for parallel agents. Temporary task branches are allowed. Plan approval permits implementation, not staging or committing.
- After explicit commit and publication approval, commit only reviewed files in the source worktree. Use `repo-guard publish --approved --verify '<combined-tree checks>'` to publish to the remote default branch without a PR. It serializes publication per repo and preserves source commits.
- Treat `~/dotfiles` as the live Stow deployment checkout. Do not edit it concurrently. Never align a dirty checkout with mixed or soft reset, direct ref changes, or index replacement. Any dirty default checkout defers deployment; use `repo-guard refresh --approved` after its changes are reconciled.
- Report review, commit, remote publication, and live verification separately. Use `Task complete. No required steps remain.` only when all required work is finished, including removal of the task's temporary worktree and branch. Otherwise say `Task incomplete: <pending steps>` and keep the source worktree. Separate required `Next steps:` from optional `Open ideas:`. Report agent-close and worktree-removal safety separately. Remove completed targets through wt or coppice only after stopping or handing off their worker, passing a fresh removal check, and reviewing ignored files.
- Conventional commit messages (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
