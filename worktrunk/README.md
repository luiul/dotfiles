# Worktrunk and Herdr app

[Worktrunk](https://worktrunk.dev) owns checkout creation, setup, and removal. [Coppice](https://github.com/luiul/coppice) supplies the daily commands. Herdr app and Core run and show terminals.

## Explicit opening

`wt-herdr` connects an existing Worktrunk checkout to Herdr app. It does not create or remove checkouts.

```sh
wt-herdr check --repo ~/dotfiles
wt-herdr open --repo ~/dotfiles --path ~/worktrees/luiul/expense-report/dotfiles
```

`cop herdr REPO --branch BRANCH` calls the helper before and after its normal Worktrunk setup. Use `--yes` to skip the existing-branch confirmation. There is no legacy Herdr session option or backend.

`cop new` and ordinary `wt switch` calls do not open an orchestrator. Keep app opening out of Worktrunk lifecycle hooks.

The helper uses the running local app and Core. It never starts or updates them. Checkout paths and Git metadata establish identity. Space titles are display names, not identity.

Each checkout has its own space. Conversations in the same checkout stay in that space. A primary-checkout parent with a Files tab lets Herdr's shipped sidebar group linked-worktree spaces beneath it without starting an extra shell.

The helper reuses a matching live Pi and focuses its pane. It stops if identity is ambiguous. A launch-specific Core label identifies the requested Pi even when its launch reply is lost. A pending launch record survives a lost reply, so a retry cannot blindly start another Pi. It does not submit a task or restart an existing agent.

New Pi terminals use the same shell behavior as Herdr's app launcher. Ctrl+C keeps its normal Pi behavior. Exiting Pi returns to a shell in the checkout, so the terminal, tab and space stay open. This applies to new launches only. Herdr still asks before an explicit close of the last tab in a space.

## Layout repair

```sh
wt-herdr repair --dry-run
wt-herdr repair
```

Repair separates clearly identified mixed checkouts while preserving terminal references and running processes. It uses version-checked document writes and updates terminal space and tab labels. It keeps a backup before changing the document. Unclear entries need inspection, not guesses.

Do not close a running terminal to repair its location. Closing a terminal pane ends its process. Before removing a checkout, stop or hand off its worker, preserve its work, and close its space.

## Deployment and checks

Stow this package from the live `~/dotfiles` checkout after review and publication:

```sh
stow --no-folding worktrunk
uv run scripts/test-wt-herdr.py
uv run scripts/test-worktree-no-editor.py
uv run scripts/test-wt-herdr-live.py --coppice-source /path/to/coppice/source
```

Source tests and live deployment are separate. Test a source helper by its absolute path before updating the live symlink. Live tests use bounded, owned `ag-` tmux sessions and close only their own terminals and fixture checkouts. The live test starts a real Pi with no submitted task in a temporary repo. It requires the reviewed helper and Coppice source.

See [Herdr app setup](../herdr/README.md) for configuration and installation boundaries.
