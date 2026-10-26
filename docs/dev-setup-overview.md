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
- Link inherited agent instructions into the owner directory.

Project hooks repair missing dbt dependencies or checkout-specific environment paths where configured. No creation hook opens an editor or an orchestrator.

## Publish personal work

Implementation approval does not authorize commits or pushes. Review the source diff first. After explicit approval, commit only the reviewed files in that worktree.

```sh
repo-guard publish --approved --verify 'your combined-tree test command'
```

The guard serializes publication per Git common directory. Different repos can publish concurrently. It fetches the actual remote default branch, combines committed work in an isolated wt-managed integration checkout, runs the supplied checks, and pushes without force. It does not stage source files, rewrite source commits, or refresh the primary checkout.

Integration uses a private wt configuration with setup hooks disabled. It does not inherit the usual `.venv`, ignored-file copying, registry, or agent-instruction links. The verification command must supply safe setup or use checks that need none. Never copy secrets or live settings into a fixture just to make a test pass.

A conflict, failed check, changed source, or rejected push stops publication. Recovery checkouts stay under the Git common directory, not temporary storage. Inspect the reported path and resolve the problem before retrying. Do not choose one side of a conflict wholesale to make a push succeed. A successful verified publication removes only its own clean integration checkout.

The lock coordinates guard commands, not arbitrary Git commands, editors, or other computers. A normal push rejects an outdated integration result. Do not force-push around it. An interrupted owner leaves a closed gate, not an automatically stolen lock. `repo-guard unlock --approved` checks process start identity before recovery; ambiguous locks need manual inspection.

Do not run `cop sync` while workers or publication are active. Its installed implementation can update both primary and source checkouts outside this lock. `--no-main` skips primary refresh, but still permits source updates. Run it only after the affected workers are idle and their work is preserved.

Network commands default to 30 seconds each. Verification defaults to 120 seconds. `REPO_GUARD_NETWORK_TIMEOUT_MS` and `REPO_GUARD_VERIFY_TIMEOUT_MS` set explicit bounds from 50 through 120000 milliseconds. Longer checks run separately before publication, then use a bounded combined-tree check.

HelloFresh uses feature branches and draft PRs instead. Never run the personal publisher for HelloFresh work.

## Live deployment

Publication and deployment are separate. Publication never updates the primary checkout. Explicit refresh can fast-forward a clean default checkout. Any reported dirt, hidden index flags, or incoming ignored-file collision defers deployment.

```sh
repo-guard refresh --approved
```

Reconcile existing work first. Verify deployed bytes and live behavior after refresh. A remote commit alone does not prove the running setup has loaded it. Existing Pi sessions need an idle reload for changed extensions.

## Completion reminder

Pi's `/work-status` shows local checkout state. The `work-completion` extension records its original baseline in session entries and reminds at settlement. It uses no network checks, polling, or render-time Git.

It distinguishes files present at startup from later observed changes. Neither the baseline nor Git status proves authorship. Cached remote refs are not current publication proof. The reminder never commits, pushes, submits another prompt, or blocks exit.

Report review readiness, commit, remote publication, and live verification separately. Keep unfinished worktrees or provide a clear handoff before closing an agent.

State closing safety separately from completion. If required steps remain, use:

```text
Task incomplete: review, publication, and deployment pending.
Agent: safe to close.
Worktree: keep.
Progress: saved in /absolute/source/worktree.
```

Use `Task complete. No required steps remain.` only when all required work is finished. Review approval, publication, and requested deployment all count as required steps. A safe pause is not completion.

Use a separate `Next steps:` heading for required actions and decisions. Use `Open ideas:` for optional out-of-scope suggestions. Omit empty sections. Optional ideas do not block completion.

After verified publication and any requested deployment, report the published commit. Worktree removal needs a fresh removal check, a stopped or handed-off worker, and an ignored-file review. Never imply that deleting unpublished work is safe.

## Remove a worktree

Stop or hand off its worker first. Use `wt remove` or `cop remove`. The global ordered `pre-remove` hook protects primary branches and runs `repo-guard check-remove`.

The checker refuses dirty or untracked targets, hidden index flags, and uncertain remote preservation. Assume-unchanged and skip-worktree flags require explicit reconciliation; sparse checkouts are not supported. It checks the target, not every unfinished worktree in the repo. Personal source commits must be preserved on the remote default branch. HelloFresh source commits can be preserved on the remote ticket branch; merged squash work needs exact PR evidence.

Offline checks fail closed. `--force`, `--force-delete`, and `--yes` do not waive the hook. Deliberate discard needs explicit scoped approval. `--no-hooks`, native orchestrator deletion, raw Git removal, and filesystem deletion bypass this safety rail.

Git status excludes ignored files. Inspect valuable ignored data separately. For unfinished sessions, prefer Sleep or keeping the checkout rather than deleting it.

## Installation and review

Implementation stays unstaged in its source worktree until reviewed. Do not restow the git or Pi package from that worktree: live links must point to `~/dotfiles`, not a checkout that may later be removed.

For this first rollout, run the reviewed checker by absolute path from the preserved source worktree. After explicit commit and publication approval, publish with that bootstrap path. Publication does not refresh live main, so the old hooks stay active until installation.

After publication, install in this order:

1. Put a reviewed executable copy at `~/.local/bin/repo-guard` and test `repo-guard status --json`. Do not point this bootstrap copy into a disposable checkout.
2. Reconcile live changes and run the reviewed `repo-guard refresh --approved`. Verify the live files against committed source. The checker is already available when the new hook becomes visible through Stow.
3. Replace the bootstrap copy with a link to `~/dotfiles/git/.local/bin/repo-guard`. Apply the matching Worktrunk configuration if it is not already linked. A missing executable makes removal fail closed.
4. Link the approved Pi extension from the live package. Test a fresh Pi session, then reload existing sessions only when idle. Keep the source checkout until these checks pass.

Full-package restow may conflict with existing live files. Inspect the dry run first. Do not use adoption or overwrite to resolve those conflicts automatically.

## Verification

```sh
node scripts/test-work-completion-policy.mjs
node scripts/test-repo-guard.mjs
bun scripts/test-work-completion.ts
node scripts/test-work-completion-live.mjs
uv run scripts/test-worktree-no-editor.py
```

These tests use disposable repos, local bare remotes, private configuration, and bounded tmux sessions. They must not publish to real remotes or remove user worktrees.

## History

The original repo-layout and worktree evaluation is in [dotfiles issue 4](https://github.com/luiul/dotfiles/issues/4). That history includes retired wtx commands, older memory behavior, and removed tooling. It is not the current command reference.

The concurrency safeguard is tracked in [dotfiles issue 89](https://github.com/luiul/dotfiles/issues/89).
