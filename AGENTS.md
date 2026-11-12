# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `aws`, `borders`, `brew`, `datagrip`, `ghostty`, `git`, `herdr`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pip`, `rectangle`, `rex`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zsh` (`docs/` and `node_modules/` are not packages)

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## Workflow

- Leave changes unstaged in the working tree until the user approves them; they review with VS Code's "Open Changes" diff view.
- Use separate wt-managed source worktrees for parallel agents. Temporary task branches are allowed. Plan approval permits implementation, not staging or committing.
- After explicit commit and publication approval, commit only reviewed files in the source worktree. Integrate current remote work, run the combined-tree checks, and push normally to the remote default branch without a PR. Coordinate publication with other workers and never force-push.
- For this personal setup, "commit and publish" includes safe live deployment and verification unless the user explicitly asks for remote-only publication. A push from a source worktree is not completion.
- Treat `~/dotfiles` as the live Stow deployment checkout. Coordinate live edits with other workers. Never align a dirty checkout with mixed or soft reset, direct ref changes, or index replacement. Fast-forward a clean live checkout after publication. A dirty checkout is not an automatic blocker: inspect ownership and overlapping paths, back up the baseline, and use a scoped deployment of reviewed published files when safe. Preserve unrelated edits, source commits, live HEAD and index. Dry-run Stow and inspect exact links; do not adopt or overwrite conflicts. Name a concrete blocker if no safe deployment path exists.
- Verify the feature in its live location and running setup before reporting completion. For Pi, check auto-discovered commands in a new process using real live settings, and state when existing sessions need `/reload`. Do not rely only on a preview or temporary source worktree. Merge only reviewed runtime settings keys and refresh their snapshots; preserve other runtime values.
- Report review, commit, publication, and live verification separately. If deployment is blocked, say "published, not deployed" and what remains unusable. Preserve unfinished changes in a named checkout. Remove completed task worktrees through wt after checking remote preservation and valuable ignored files. Never remove another worker's checkout.
- Conventional commit messages (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
