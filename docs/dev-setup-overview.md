# Development setup: repos and worktrees

## Current workflow

Source repos live under `~/projects/hellofresh/<repo>` and `~/projects/personal/<repo>`. Dotfiles live at `~/dotfiles`.

[Worktrunk](https://worktrunk.dev) owns worktree creation and removal. [Coppice](https://github.com/luiul/coppice) provides the daily commands. Orca and Herdr run agents in wt-managed checkouts. They do not own their deletion.

Worktrees use `~/worktrees/<owner>/<branch>/<repo>`. The repo is the leaf directory. Identity comes from Git metadata, never from parsing that path. Repo-wide Pi memory follows the main checkout through linked-worktree metadata.

```sh
cop new /path/to/repo --branch task-name --base origin/main
cop orca /path/to/repo --branch task-name --base origin/main
cop herdr /path/to/repo --branch task-name --base origin/main
```

Replace `origin/main` with the repo's verified remote default branch. `cop new` creates or reuses a worktree and enters it without opening an orchestrator. `cop orca` and `cop herdr` finish setup, open or reuse Pi, focus the chosen workspace, and enter its worktree. Cmd+E opens VS Code when needed. There is no global orchestrator-opening hook.

HelloFresh branches use `type/TICKET-description` from the start. Personal task branches can use short names. Temporary branches do not change the personal publication rule: the remote default branch receives approved work without a PR.

## Parallel work

Run each agent in a separate source worktree. Implementation and tests can run concurrently. Reviewed commits can also be created independently after approval.

Do not stage, stash, reset, or overwrite another agent's checkout. Coordinate overlapping changes before integration. Keep source commits until publication is verified.

The primary dotfiles checkout is a live Stow deployment. Do not use it as a shared integration workspace. Never advance its HEAD with a mixed reset while retaining old working files.

## Setup hooks

The user configuration is `worktrunk/.config/worktrunk/config.toml`.

Before creation, the hook fetches origin without changing the live checkout or a local branch. Pass `--base origin/<verified-default>` for a new task based on current remote work. An offline fetch does not block creation; it does not establish freshness.

Creation hooks:

- Link an existing `.venv` from the main checkout.
- Copy other ignored setup files with `wt step copy-ignored`.
- Register the repo for Coppice and understory.

Pi's `scoped-agent-context` extension reads inherited instructions from the primary checkout's parent ancestry. It uses Git identity, not the remote owner. Repo-local instructions stay native. Worktrunk does not create instruction links in shared owner or branch directories. Known legacy HelloFresh owner links are excluded from new model requests without changing those links on disk.

Project hooks repair missing dbt dependencies or checkout-specific environment paths where configured. No creation hook opens an editor or an orchestrator.

## Publish personal work

Implementation approval does not authorize commits or pushes. Review the source diff first. After explicit approval, commit only the reviewed files in that worktree.

Fetch the verified remote default branch, integrate current remote work without rewriting source commits, and run the combined-tree checks. Push normally to the remote default branch. Coordinate with other workers in the same repo. A conflict, failed check, changed source, or rejected push stops publication. Never force-push or discard another worker's files to resolve it.

Do not run `cop sync` while affected workers or publication are active. It can update primary and source checkouts. Run it only when those workers are idle and their work is preserved.

HelloFresh uses ticket branches and draft PRs instead of direct default-branch publication.

## Live deployment

Publication and deployment are separate. Update a clean primary checkout with a normal fast-forward after publication. Preserve unrelated local changes when deployment must wait. Never use mixed reset, direct checked-out ref changes, or index-only shortcuts.

Verify deployed files and live behavior. A remote commit alone does not prove the running setup loaded it. Existing Pi sessions need an idle reload for changed extensions.

## Closing and removal

Report pending review, publication, and deployment before closing an agent. Saved files and Pi sessions remain in the checkout; closing an agent does not delete them.

Use `wt remove` or `cop remove` for worktree removal after stopping its worker. The protected-branch hook remains. Native wt checks dirty files and branch merge status, but does not prove remote publication. Check preservation yourself before removing a completed task. `--force` and `--force-delete` are not permission to discard work. Git status excludes ignored files, so inspect valuable ignored data separately.

Prefer Orca Sleep or keeping the checkout for unfinished work. Keep Pi's existing session files. No completion reminder or publication gate is installed.

## Verification

```sh
node scripts/test-worktree-policy.mjs
uv run scripts/test-worktree-no-editor.py
bun scripts/test-scoped-agent-context.ts
node scripts/test-scoped-agent-context-live.mjs
node scripts/test-hermes-review.mjs
```

These tests use disposable fixtures and bounded processes. They must not publish to real remotes or remove user worktrees.

## History

The original repo-layout and worktree evaluation is in [dotfiles issue 4](https://github.com/luiul/dotfiles/issues/4). That history includes retired wtx commands, older memory behavior, and removed tooling.

The removed concurrency safeguard is recorded in [dotfiles issue 89](https://github.com/luiul/dotfiles/issues/89). Git history preserves its code and tests if needed later.
