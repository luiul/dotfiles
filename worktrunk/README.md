# Worktrunk and orchestrators

[Worktrunk](https://worktrunk.dev) owns checkout creation, setup, and removal. [Coppice](https://github.com/luiul/coppice) supplies the daily commands. Ghostty and Rex provide terminals. Orca runs agents in Worktrunk checkouts.

## Orca workflow

Use `cop orca REPO --branch BRANCH` to create or reuse a Worktrunk checkout, then open Pi in Orca. Orca must already be running. Use `cop new` or `wt switch` when you only need the checkout.

Leave Orca's setup script empty for this workflow. Worktrunk already links the existing `.venv`, copies ignored files, registers the repo, and runs repo-specific setup. Orca's setup script runs after its own checkout creation, so it must not call `cop new` or `wt switch` to create another checkout. Install missing dependencies explicitly for the repo being changed, not through a generic `pnpm install` script.

Keep external worktrees visible in Orca. Create and remove checkouts through Worktrunk or Coppice, not Orca's native worktree actions.

`cop new` and ordinary `wt switch` calls do not open an orchestrator. Keep app opening out of Worktrunk lifecycle hooks.

## Rex tab cleanup

Run `wt remove` or `cop remove BRANCH --repo REPO` from the worktree's shell in Rex. After Worktrunk removes the checkout and moves the shell out, the Dotfiles Zsh wrapper closes the tab. This applies only to a verified single-pane caller with no shell jobs.

Failed removals, split tabs, other checkouts, and calls outside Rex leave the tab open. If another pane is added during closure, Rex closes only the caller's pane and preserves the new pane.

After the last tab closes, the same Rex client checks for remaining windows and detached blocks. If none remain, it deletes the session. Its supervisor has a ten-second deadline, with a one-second stop grace period. Rex has no conditional empty-session deletion. A block created between those checks and deletion can also close. This is an accepted tradeoff, not an atomic guarantee.

Worktrunk still owns removal and its safety checks. `command wt remove` and `command cop remove` bypass the Zsh wrappers and leave the tab open.

## Empty directory cleanup

Default removal briefly keeps an empty checkout directory so the caller's shell can move out. The post-remove hook waits up to ten seconds for that directory to disappear. It then removes empty branch and owner directories, stopping at `~/worktrees` or the first non-empty directory. Files, sibling checkouts, and paths outside this root stay unchanged. A removal that takes longer than ten seconds can still leave empty parents.

## Deployment and checks

Stow this package from the live `~/dotfiles` checkout after review and publication:

```sh
stow --no-folding worktrunk
uv run scripts/test-worktree-no-editor.py
zsh -f scripts/test-wt-rex-coppice.zsh
node scripts/test-wt-rex-remove.mjs
node scripts/test-wt-rex-cleanup-errors.mjs
```

Source tests and live deployment are separate. Test a source helper by its absolute path before updating the live symlink.

The Rex removal fixture uses the maintained private Rex driver. It closes only its own terminals and worktrees.
