# Orca

Stably's Orca (https://onorca.dev), installed as a Homebrew cask (`stablyai/orca/orca`, added to `brew/Brewfile`). It runs CLI agents side-by-side, each in its own git worktree, and has first-class pi integration (auto-detect, live status via a per-PTY extension overlay — it never touches `~/.pi/agent/settings.json` — structured native chat, session resume, background helper rows).

## Paths

- `~/.orca` — worktrees and agent state (Orca-managed, native worktree lifecycle)
- `~/Library/Application Support/orca/` — Electron userData: settings (`orca-data.json`), daemon config + API token (`config.json`, secret, never stow or surface)
- `~/Library/Caches/com.stablyai.orca*` — caches

## Worktree ownership

Worktrees created by Orca live under `~/.orca` and are managed by Orca, deliberately bypassing worktrunk. Do not point Orca's native worktree flow at repos registered in worktrunk (`wt`) or add Orca-created worktrees to the worktrunk registry — two managers on one repo gets confusing. Test repos only.

## Per-repo worktree sharing

Orca reads per-repo config for what to materialize into fresh worktrees (clean checkouts miss gitignored paths):

- `orca.yaml` — `worktree.sharedDirectories` (symlink/share large rebuildable trees)
- `.worktreeinclude` — gitignored files to copy per worktree (e.g. `.env`)

Both live in the repo, not in dotfiles.
