# Herdr app and Core

[Herdr app](https://github.com/herdrdev/herdr-app) owns the desktop window, spaces, tabs, and panes. [Herdr Core](https://github.com/herdrdev/herdr-core) owns terminal processes. [Worktrunk](https://worktrunk.dev) owns worktree creation, setup hooks, and removal. [Coppice](https://github.com/luiul/coppice) provides the daily commands.

## Installation ownership

Use the official app and Core installers or their supported package managers. The [app install guide](https://github.com/herdrdev/herdr-app/tree/v0.1.13#install) describes the signed macOS app and Core installation. The existing `herdr-app` and `hc` installation is sufficient. Dotfiles do not install, replace, or patch either executable or the signed app.

The old terminal Herdr configuration, Worktrunk plugin, manual helper, and named-session tests are removed. No compatibility path remains. Do not install the old plugin or use its session commands.

## Explicit Worktrunk integration

`wt-herdr` lives in the Worktrunk stow package at `worktrunk/.local/bin/wt-herdr`, not this package. It provides three explicit operations:

- `check`: inspect app/Core readiness and repository validity. It does not inspect or repair the space structure.
- `open`: repair clear grouping drift for the requested repo, then open or reuse its worktree space and Pi terminal.
- `repair`: inspect or repair layout problems across all spaces explicitly, never as a global wt hook.

Create the worktree with Worktrunk, then open it with `wt-herdr`. Use the repo's verified remote default branch as the base. Set `--path` to the worktree root that Worktrunk reports.

```sh
wt-herdr check --repo /path/to/repo
wt -C /path/to/repo switch --create feature-name --base origin/main --no-cd
wt-herdr open --repo /path/to/repo --path /path/to/worktree
```

For an existing worktree, skip creation and pass its path to `open`. The helper focuses the verified Pi terminal without changing the calling shell's directory. App/Core is the integration target, not a named terminal Herdr server.

Use a dedicated Files-only repo parent with no terminals, separate from checkout conversations. It stays at the primary checkout even when a calling shell enters a linked worktree. Nest linked-worktree conversation spaces under it using Git identity, not names or path segments. Preserve existing conversation spaces and custom names. Reuse Pi only for the exact worktree and terminal identity. A pending launch is not permission to start another Pi. Wait for readiness or report the pending state instead.

`cop new` and `wt switch` remain worktree-only. No global wt hook opens Herdr, Core terminals, Pi, or an editor. Do not use native app worktree creation or deletion for wt-managed checkouts. Stop or hand off the worker before removal through `cop remove` or `wt remove`. Close its space first or use the [opt-in Herdr removal guard](../worktrunk/README.md#opt-in-herdr-removal). Cmd+E inside Pi remains the manual editor shortcut.

## Personal configuration

Only `.config/herdr-app/settings.json` is tracked here. It copies the current personal display and sound preferences without changing their values. Stow individual files with `stow --no-folding herdr` after reviewing live conflicts. This cleanup does not run Stow or change live symlinks.

Symlink safety was checked against the installed app's official v0.1.13 source:

- [Settings](https://github.com/herdrdev/herdr-app/blob/v0.1.13/src/settings.rs) writes through [persist](https://github.com/herdrdev/herdr-app/blob/v0.1.13/src/persist.rs), which resolves symlink targets before atomic replacement. Its tests cover link chains and missing targets.
- [Keys](https://github.com/herdrdev/herdr-app/blob/v0.1.13/src/keys.rs) writes through file symlinks. The current keys match shipped macOS defaults, so no copy is needed.
- [Programs](https://github.com/herdrdev/herdr-app/blob/v0.1.13/src/programs.rs) reads personal overrides. No personal `programs.json` exists, so none is added.

Never stow the whole live `~/.config/herdr-app` directory. Leave spaces, terminal data, sockets, window state, generated mods, icons, telemetry, and update records app-owned. Preserve Core state and signed applications. If a future version stops preserving file symlinks, use the live file vs snapshot pattern with `.stow-local-ignore` instead.

## Verification

See the [Worktrunk helper checks](../worktrunk/README.md#deployment-and-checks). Run the source tests without changing the running app. The live fixtures are separate and use their own spaces and terminals. They do not change user settings.
