# Herdr and Worktrunk

Herdr owns terminal workspaces and the sidebar. [Worktrunk](https://worktrunk.dev) owns checkout creation, setup hooks, and removal. [Coppice](https://github.com/luiul/coppice) remains the human CLI for worktree lifecycle.

The installed [Herdr Worktrunk plugin](https://github.com/devashish2203/herdr-worktrunk) is pinned to `f9df9ba700b8a4f4d97ddfe3ea3eb345e80b880b`. It uses `wt` before opening an existing checkout with `herdr worktree open`. Workspace mode gives each checkout a native linked-worktree workspace under its repo in the sidebar.

## Keys

- Ctrl+B, then Shift+G: select an existing checkout or create a new branch through wt.
- Ctrl+B, then Shift+D: select a worktree for removal through wt, with its normal safety checks.
- Escape: cancel the picker.

The native worktree keybindings are disabled. Native sidebar context-menu creation and `herdr worktree create/remove` still use Git directly. Do not use those for managed worktrees. Use the plugin actions, `cop new/remove`, or `wt switch/remove` instead.

## Coppice and agent commands

Inside a Herdr pane, the wt post-switch hook calls `herdr-wt-open`. It opens new or reused linked checkouts in the calling session without changing focus. The helper uses `HERDR_SOCKET_PATH`, so it cannot silently target another session. Repeated calls preserve the workspace and its custom label. It never creates a Git checkout or starts a Herdr server.

Outside Herdr, wt and coppice keep their normal behavior. No Herdr workspace is opened. The plugin picker can select those checkouts later.

The plugin closes a workspace after successful removal through its own picker. Removal through coppice or wt does not automatically close a Herdr workspace. Close its workspace explicitly before removing the checkout. An automatic close could kill an agent, so no teardown hook does that.

Worktree creation does not open VS Code. Cmd+E inside pi remains the manual editor shortcut. Canopy and understory retain Ghostty-only title-based navigation. This setup does not change Orca.

## Limits

The plugin opens a checkout at its root. It does not preserve a nested dbt project directory from the source pane. Change into that project before starting pi so its skills and manual Cmd+E use the intended scope. Upstream tracks this in https://github.com/devashish2203/herdr-worktrunk/issues/14.

No merge key is added. The plugin's merge action can stage and commit through wt, which conflicts with the agent commit review gate.

## Installation and files

```sh
herdr plugin install devashish2203/herdr-worktrunk --ref f9df9ba700b8a4f4d97ddfe3ea3eb345e80b880b --yes
stow herdr
herdr config check
herdr server reload-config
```

The package stows the helper, `config.toml`, and `plugins/config/worktrunk/config.toml`. Both live config files link to their tracked versions. Herdr's managed plugin installation and runtime state are not tracked. Back up conflicting live config files before stowing on another machine.

To update the plugin, choose a new commit, review its source, install that ref, and rerun the test. A pinned install does not follow upstream main automatically.

## Verification

```sh
bash scripts/test-herdr-worktrunk.sh
uv run scripts/test-worktree-no-editor.py
```

The integration test starts a bounded named Herdr session in tmux. It tests the real keybinding, installed picker, real wt and cop creation/reuse, native workspace provenance, rendered sidebar labels, custom-label preservation, focus preservation, setup hooks, zero editor calls, and plugin removal. Only fzf selection is scripted for deterministic lifecycle checks. The separate interactive picker check uses real fzf. Test workspaces, sessions, and fixtures are cleaned up without changing live user workspaces.
