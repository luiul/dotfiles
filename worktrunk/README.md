# Worktrunk and orchestrators

[Worktrunk](https://worktrunk.dev) owns checkout creation, setup, and removal. [Coppice](https://github.com/luiul/coppice) supplies the daily commands. Orca and Herdr are optional surfaces for terminals and agents.

## Orca workflow

Use `cop orca REPO --branch BRANCH` to create or reuse a Worktrunk checkout, then open Pi in Orca. Orca must already be running. Use `cop new` or `wt switch` when you only need the checkout.

Leave Orca's setup script empty for this workflow. Worktrunk already links the existing `.venv`, copies ignored files, registers the repo, and runs repo-specific setup. Orca's setup script runs after its own checkout creation, so it must not call `cop new` or `wt switch` to create another checkout. Install missing dependencies explicitly for the repo being changed, not through a generic `pnpm install` script.

Keep external worktrees visible in Orca. Create and remove checkouts through Worktrunk or Coppice, not Orca's native worktree actions.

## Explicit Herdr opening

`wt-herdr` connects an existing Worktrunk checkout to Herdr app. It does not create or remove checkouts or change the calling shell's directory.

```sh
wt-herdr check --repo ~/dotfiles
wt -C ~/dotfiles switch --create task-name --base origin/main --no-cd
wt-herdr open --repo ~/dotfiles --path ~/worktrees/luiul/task-name/dotfiles
```

Use the repo's verified remote default branch as the base. If the worktree already exists, pass its root to `open` without running `wt switch`.

`cop new` and ordinary `wt switch` calls do not open an orchestrator. Keep app opening out of Worktrunk lifecycle hooks.

The helper uses the running local app and Core. It never starts or updates them. Checkout paths and Git metadata establish identity. Space titles are display names, not identity.

Each repo has a dedicated Files-only parent with no terminals. Its folder stays at the primary checkout, so shell navigation cannot change the parent. The helper marks this role in the Files pane's props and places the parent before its conversations. It never launches Pi into that parent.

Conversations use separate checkout spaces. Existing spaces and custom names are preserved, including several conversations at the same checkout. Existing names are preserved; new checkout spaces use their branch name. Herdr's shipped sidebar groups linked-worktree spaces beneath the stable parent without starting an extra shell.

Opening first repairs clear grouping drift in spaces connected to the requested repo. Shell navigation can change a space's checkout after an earlier repair. The helper preserves running terminals and uses the same backup, version check, and label reconciliation as explicit repair. Unrelated spaces stay unchanged. Unclear mod context or a touched pending launch still stops the command.

The helper reuses a matching live Pi and focuses its pane. It stops if identity is ambiguous. A launch-specific Core label identifies the requested Pi even when its launch reply is lost. A pending launch record survives a lost reply, so a retry cannot blindly start another Pi. It does not submit a task or restart an existing agent.

New Pi terminals use the same shell behavior as Herdr's app launcher. Ctrl+C keeps its normal Pi behavior. Exiting Pi returns to a shell in the checkout, so the terminal, tab and space stay open. This applies to new launches only. Herdr still asks before an explicit close of the last tab in a space.

## Layout repair

```sh
wt-herdr repair --dry-run
wt-herdr repair
```

Repair separates clearly identified mixed checkouts while preserving terminal references and running processes. A tab without terminals stays in its original space and keeps its folder context. When a shell moves to another checkout, repair can leave that space and its Files tab unchanged and move terminal-only tabs into the matching checkout space. Repair refuses when it cannot preserve the folder context of a mod pane. A tab with terminals from one checkout stays intact. Repair refuses to split a tab with terminals from different checkouts when that tab also has mod or unclear panes. It also refuses a mixed space containing a marked repository parent pane. It uses version-checked document writes and updates terminal space and tab labels. It keeps a backup before changing the document. Unclear entries need inspection, not guesses.

Do not close a running terminal to repair its location. Closing a terminal pane ends its process. Before removing a checkout, stop or hand off its worker and preserve its work. Opt-in removal closes verified idle checkout spaces automatically.

## Opt-in Herdr removal

Default `wt remove` and `cop remove` calls do not contact Herdr. They retain the protected-branch check, native Worktrunk removal checks, and empty branch-directory cleanup. They do not inspect Herdr terminals or close Herdr spaces. Before removing a Herdr-used checkout, close its space or enable the Herdr guard explicitly.

With `WT_HERDR_REMOVE=1`, the shared Worktrunk hooks check every tab and pane using the target checkout, not just the caller's tab. A running Pi, another program, a background shell job, or unclear checkout/process identity blocks deletion. `--yes`, `--force`, and `--force-delete` do not bypass this guard. The stable repository parent and unrelated spaces stay unchanged. A space shared with another checkout stays open, including its unrelated agents, shell tabs, and Files context. You can navigate a shell tab into a temporary checkout and run bare `wt remove` there. The helper checks that target checkout's work, lets Worktrunk navigate the caller normally, and preserves the shared space. Work in another checkout does not block deletion by itself. Unknown terminal context still blocks it.

After a successful removal, a background hook closes only recorded idle spaces dedicated to the target checkout. A stale stored folder never grants permission to close a space whose terminals use another checkout. It records identity before Worktrunk moves the checkout into trash. When the caller is inside a matching Herdr space, cleanup waits for the removal command and shell wrapper to finish before closing that shell. The wait has an 85-second deadline. New work or a changed layout stops cleanup instead of killing it.

Use the feature flag to enable the Herdr guard and cleanup for one call:

```sh
WT_HERDR_REMOVE=1 wt remove
WT_HERDR_REMOVE=1 cop remove my-branch
```

Only the exact value `1` enables these hooks. An unset flag, `0`, or any other value skips Herdr commands. Opening with `wt-herdr open` does not enable these hooks.

Do not use `--no-hooks` as the feature switch. It also skips other Worktrunk safeguards. Enabled removal does not start Herdr or Core. If Core is unavailable, the enabled guard cannot establish that no space exists and refuses removal. With Core available and no matching space, enabled removal proceeds without contacting the app window.

If cleanup fails after deletion, the hook logs `Worktree removed, Herdr cleanup incomplete` and preserves its record. Inspect `wt config state logs`, then retry the exact `wt-herdr finish-remove --path ...` command from a shell outside the recorded space. The helper refuses if the checkout is still registered, Core changed, the layout changed, or a terminal is busy. It never reruns checkout deletion.

The guard verifies a process snapshot. It cannot prevent an external actor starting work between verification and closure. Detached processes that left both the terminal ancestry and checkout context are outside this proof; stop owned workers before removal.

## Deployment and checks

Stow this package from the live `~/dotfiles` checkout after review and publication:

```sh
stow --no-folding worktrunk
uv run scripts/test-wt-herdr.py
uv run scripts/test-wt-herdr-handoff-safety.py
uv run scripts/test-wt-herdr-remove.py
uv run scripts/test-worktree-no-editor.py
```

Source tests and live deployment are separate. Test a source helper by its absolute path before updating the live symlink.

Run the live fixtures one at a time while the app is idle. They change app focus and use the maintained private Rex driver. They close only their own terminals, spaces, and worktrees.

```sh
uv run scripts/test-wt-herdr-live.py
node scripts/test-wt-herdr-remove-live.mjs
```

The opening fixture uses Worktrunk and the source `wt-herdr` helper directly. It starts Pi with no submitted task in a temporary repo. Its first command runs in a real Herdr caller shell. The fixture then changes that shell's directory explicitly to test grouping and repair.

See [Herdr app setup](../herdr/README.md) for configuration and installation boundaries.
