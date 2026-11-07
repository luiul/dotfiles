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

Each repo has a dedicated Files-only parent with no terminals. Its folder stays at the primary checkout, so shell navigation cannot change the parent. The helper marks this role in the Files pane's props and places the parent before its conversations. It never launches Pi into that parent.

Conversations use separate checkout spaces. Existing spaces and custom names are preserved, including several conversations at the same checkout. Existing names are preserved; new checkout spaces use their branch name. Herdr's shipped sidebar groups linked-worktree spaces beneath the stable parent without starting an extra shell.

Opening first repairs clear grouping drift in spaces connected to the requested repo. Shell navigation can change a space's checkout after an earlier repair. The helper preserves running terminals and uses the same backup, version check, and label reconciliation as explicit repair. Unrelated spaces stay unchanged. Unclear mod context or a touched pending launch still stops the command.

The helper reuses a matching live Pi and focuses its pane. It stops if identity is ambiguous. A launch-specific Core label identifies the requested Pi even when its launch reply is lost. A pending launch record survives a lost reply, so a retry cannot blindly start another Pi. It does not submit a task or restart an existing agent.

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

Source tests and live deployment are separate. Test a source helper by its absolute path before updating the live symlink. Live tests use bounded, owned `ag-` tmux sessions and close only their own terminals and fixture checkouts. The live test starts a real Pi with no submitted task in a temporary repo. Its first command runs in a real Herdr caller shell, then checks the stable parent after shell navigation. It requires the reviewed helper and Coppice source.

See [Herdr app setup](../herdr/README.md) for configuration and installation boundaries.
