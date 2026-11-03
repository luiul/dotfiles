# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `aws`, `borders`, `brew`, `datagrip`, `ghostty`, `git`, `herdr`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zsh` (`docs/` and `node_modules/` are not packages)

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## Workflow

- Leave changes unstaged in the working tree until the user approves them; they review with VS Code's "Open Changes" diff view.
- Use separate wt-managed source worktrees for parallel agents. Temporary task branches are allowed. Plan approval permits implementation, not staging or committing.
- After explicit commit and publication approval, commit only reviewed files in the source worktree. Integrate current remote work, run the combined-tree checks, and push normally to the remote default branch without a PR. Coordinate publication with other workers and never force-push.
- Treat `~/dotfiles` as the live Stow deployment checkout. Do not edit it concurrently. Never align a dirty checkout with mixed or soft reset, direct ref changes, or index replacement. Fast-forward a clean live checkout after publication, then verify the deployed files and running behavior. Preserve unrelated changes when deployment must wait.
- Report review, commit, publication, and live verification separately. Preserve unfinished changes in a named checkout. Remove completed task worktrees through wt after checking remote preservation and valuable ignored files. Never remove another worker's checkout.
- Conventional commit messages (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
