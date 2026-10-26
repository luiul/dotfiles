# Orca

Stably's Orca (https://onorca.dev), installed as a Homebrew cask (`stablyai/orca/orca`, added to `brew/Brewfile`). It runs CLI agents side-by-side, each in its own git worktree, and has first-class pi integration (auto-detect, live status via a per-PTY extension overlay — it never touches `~/.pi/agent/settings.json` — structured native chat, session resume, background helper rows).

## Paths

- `~/.orca` — worktrees and agent state (Orca-managed, native worktree lifecycle)
- `~/Library/Application Support/orca/profiles/local-default/profile-state.db` — live SQLite settings store (domain `settings`); `orca-data.json` only survives as a legacy export/migration artifact. Settings have no write CLI; drive the Settings UI via `orca computer` commands (Accessibility + Screenshots permission for the "Orca Computer Use" helper required once)
- `~/Library/Caches/com.stablyai.orca*` — caches

## Worktree ownership

Creation and removal of worktrees are owned by worktrunk (`wt`) and coppice (`cop`), including for repos registered in Orca. Orca is the watching and agent layer: it auto-discovers wt-created worktrees of a registered repo and runs pi terminals in them. Verified with a live throwaway-repo test (2026-10-25): `cop list` flags an Orca-native worktree as mismatched, `cop relocate` would move it away from Orca's registry path, and `cop clean` can sweep it.

- Never use Orca's native flow (`orca worktree create`, New Workspace in the UI) on repos registered in wt. Orca-native worktrees land under `~/orca/workspaces` (off wt's path template), skip every wt hook (venv symlink, copy-ignored, AGENTS.md links, registry, default-branch freshen), and become destructive interference for `cop relocate` and `cop clean`.
- Remove worktrees through `wt remove` / `cop remove` only. Orca's delete on a wt-created worktree skips wt's protected-branch guard and the parent-dir prune hook.
- Register a repo for watching with `orca repo add --path <main checkout>`, then `orca repo set --repo path:<main checkout> --external-worktree-visibility show`. The global default stays `hide`, so throwaway test repos stay out of the sidebar; per-repo `show` marks the wt-managed ones (dotfiles and canopy today).
- Orca's own worktree flow remains fine for throwaway test repos that are never registered in wt.

## Watch a repo from the terminal

`orca-watch` (alias `owa`) registers the main checkout and shows its external worktrees. It does not create worktrees, launch agents, or change your directory. Orca must be running. The helper needs `git`, `orca`, and `jq`.

```zsh
# Pass a repo path from anywhere.
owa ~/projects/personal/canopy
orca-watch "/path/to/my repo"

# Omit the path inside a repo, subdirectory, or linked worktree.
owa

# Relative paths work too.
owa ../canopy
```

Both names complete directory paths with Tab. Linked worktrees resolve to the main checkout. Repeated calls keep the same repo registered and set its external worktree visibility to `show`. An invalid path or an Orca error stops the command without a success message. If registration succeeds but setting visibility fails, the repo stays registered. Run the command again after fixing the error.

The function lives in `zsh/.zsh_config/funcs_orca.zsh`. Completion lives in `zsh/.zfunc/_orca-watch`. Run `zsh -f scripts/test-orca-watch.zsh` to check path handling and failure cases without changing your Orca registrations.

The [Coppice workflow](https://github.com/luiul/coppice) combines watching, worktree creation or reuse, setup, and Pi launch in one command: `cop orca [repo]`. It uses wt for creation, then opens the verified Pi terminal in Orca. `cop new` remains worktree-only, even in a watched repo. Both commands accept `--branch`, `--base`, and `--yes`. Retry or reopen with `cop orca /path/to/repo --branch branch-name --yes`. Shell integration enters the resulting worktree. Direct wt, agent-marked, piped, and Herdr calls do not start this workflow. The watch helper remains available but is no longer a required first step. Opening Pi's terminal binds its PTY to sidebar state, so Hide sleeping keeps the worktree visible even when Pi is idle.

Before deleting a disposable registered repo, close its terminal tabs with `orca terminal close --worktree path:<checkout> --all --json`. Removing its project setup can leave terminal tabs and resume records behind. If the repo is already gone, find the exact stale handle in `orca terminal list --json` and close only that tab with `orca terminal close --terminal <handle> --tab --json`.

## Per-repo worktree sharing

Orca reads per-repo config for what to materialize into fresh worktrees (clean checkouts miss gitignored paths):

- `orca.yaml` — `worktree.sharedDirectories` (symlink/share large rebuildable trees)
- `.worktreeinclude` — gitignored files to copy per worktree (e.g. `.env`)

Both live in the repo, not in dotfiles.
