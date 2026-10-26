# Herdr and Worktrunk

Herdr owns terminal workspaces and the sidebar. [Worktrunk](https://worktrunk.dev) owns checkout creation, setup hooks, and removal. [Coppice](https://github.com/luiul/coppice) remains the human CLI for worktree lifecycle.

The installed [Herdr Worktrunk plugin](https://github.com/devashish2203/herdr-worktrunk) is pinned to `f9df9ba700b8a4f4d97ddfe3ea3eb345e80b880b`. It uses `wt` before opening an existing checkout with `herdr worktree open`. Workspace mode gives each checkout a native linked-worktree workspace under its repo in the sidebar.

## Keys

- Ctrl+B, then Shift+G: select an existing checkout or create a new branch through wt.
- Ctrl+B, then Shift+D: select a worktree for removal through wt, with its normal safety checks.
- Escape: cancel the picker.

The native worktree keybindings are disabled. Native sidebar context-menu creation and `herdr worktree create/remove` still use Git directly. Do not use those for managed worktrees. Use the plugin actions, `cop new/remove`, or `wt switch/remove` instead.

## Coppice and agent commands

Use `cop herdr [repo]` from an interactive shell to create or reuse a worktree, finish wt setup, and open Pi in Herdr. The repo defaults to the current directory. Use `--branch NAME` or answer the branch prompt. Like `cop orca`, this explicit command focuses the verified Pi terminal and changes the calling shell to the checkout directory.

Inside Herdr, `cop herdr` targets the calling session through `HERDR_SOCKET_PATH`. Outside Herdr, it targets the running default session. Use `--session NAME` to choose another running session. The command does not start a Herdr server. Reuse focuses an existing ready Pi instead of starting another one.

```sh
cop herdr
cop herdr ~/projects/personal/example --branch feature-name
cop herdr ~/projects/personal/example --branch feature-name --yes --session review
```

`cop new` and direct `wt switch` calls remain worktree-only, even inside Herdr. They run normal setup without opening workspaces or Pi. There is no global Herdr post-switch hook. The plugin picker still opens its own workspace through `herdr worktree open`.

`herdr-wt-open REPO_PATH WORKTREE_PATH` remains a manual legacy helper. It opens an existing checkout without changing focus or starting Pi. It needs an explicit calling Herdr socket and preserves custom workspace labels. Normal wt setup and `cop herdr` do not need this helper.

The plugin closes a workspace after successful removal through its own picker. Removal through coppice or wt does not automatically close a Herdr workspace. Close its workspace explicitly before removing the checkout. An automatic close could kill an agent, so no teardown hook does that.

Worktree creation does not open VS Code. Cmd+E inside pi remains the manual editor shortcut. Canopy and understory retain Ghostty-only title-based navigation.

## Limits

The plugin opens a checkout at its root. It does not preserve a nested dbt project directory from the source pane. Change into that project before starting pi so its skills and manual Cmd+E use the intended scope. `cop herdr` also starts Pi at the checkout root. Upstream tracks plugin directory handling in https://github.com/devashish2203/herdr-worktrunk/issues/14.

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

The integration test starts an isolated named Herdr session in tmux. Both test tmux sessions have registered owners, 300-second deadlines, and explicit cleanup. It tests the real keybinding, installed picker, native workspace provenance, setup hooks, custom-label preservation, focus preservation, and plugin removal. It verifies that `cop new` and direct wt creation/reuse open no Herdr workspaces, even inside Herdr. It also checks the manual legacy helper with spaced paths, the absence of a global registration hook, and zero editor calls. Only fzf selection is scripted for deterministic lifecycle checks. The separate interactive picker check uses real fzf. Test workspaces, sessions, and fixtures are cleaned up without changing live user workspaces. This script does not exercise `cop herdr` Pi launch.
