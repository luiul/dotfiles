# Dotfiles Glossary

Vocabulary for this repo and the setup it manages. Precedence per the Ubiquitous Language rule in the global AGENTS.md: repo glossary first, then the shared org glossary (`~/projects/hellofresh/docs/glossary.md`), then generic usage. The glossary centralizes terms from existing docs; it does not invent new ones. When a term is missing or ambiguous, propose an entry. Canonical after review.

## stow package

A top-level directory in this repo that mirrors the home directory layout. GNU Stow symlinks it into `$HOME` with `stow <package>`, so files land at their target paths. Each package is one config area, for example `pi`, `zsh`, or `git`. `docs/` and `node_modules/` are not packages.

Source: `~/dotfiles/AGENTS.md`, Structure section.

## live file vs snapshot

The pattern for files an app rewrites at runtime (for example `~/.claude/settings.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/mcp-adapter.json`). The file in `$HOME` is the live file and the source of truth; it is NOT stowed, because the app's runtime rewrite would clobber a symlink. The dotfiles copy is a snapshot, refreshed with `cp` after editing the live file.

Source: `pi/.pi/agent/AGENTS.md`, Dotfiles section.

## stow-local-ignore

A per-package ignore file that lists files GNU Stow must not symlink into `$HOME`. It guards the live files of the live file vs snapshot pattern: `claude/.claude/settings.json` (`claude/.stow-local-ignore`), `pi/.pi/agent/settings.json` and `pi/.pi/agent/mcp-adapter.json` (`pi/.stow-local-ignore`).

Source: `pi/.stow-local-ignore`, `claude/.stow-local-ignore`, and `pi/.pi/agent/AGENTS.md`, Dotfiles section.

## worktree

A linked git working tree checked out alongside the main repo. In this setup, worktree lifecycle is owned by [worktrunk](https://worktrunk.dev) (`wt`, config at `worktrunk/.config/worktrunk/config.toml`): agents create or switch worktrees with `WORKTRUNK_AGENT=1 wt switch --create <branch> --no-cd --yes --format json`. Raw `git worktree add` is never used; it skips the venv, copy-ignored, and registry hooks.

Source: `pi/.pi/agent/AGENTS.md`, Worktrees section.

## split panels

The right column panels of the pi split extension: Thinking, Tool Usage, and File Changes. The left column holds the full transcript or a response-only view. File Changes is the biggest panel by design (45% of the right column rows by default). File Changes reads the shared `filechanges-tracker.ts` state, so the panel and the above-editor widget always show the same rows.

Source: `pi/.pi/agent/extensions/README.md`, the `split.ts` section.

## layer

In the pi TUI, a layout layer is a wrap builder: it receives the inner root component and returns a wrapped root. `split/split-layout.ts` owns pi's single fullscreen layout-root slot and composes `baseRoot → layer1 → layer2 → …` from its ordered set of active layers. Extensions register as layers so they never fight over the root, and `/reload` unwraps stale compositions.

Source: `pi/.pi/agent/extensions/split/split-layout.ts` (header comment) and `pi/.pi/agent/extensions/README.md`.

## harvest

The local Business Impact database for Jira tickets and GitHub PRs: DuckDB + Apache Iceberg stored under `~/.harvest/` (repo: `~/projects/personal/harvest`, CLI: `harvest`). Harvest is the source of truth for all six impact fields; the Jira ticket and the GitHub PR are projections. Jira and GitHub are the sources of truth for lifecycle, which `harvest sync` ingests.

Source: `~/projects/hellofresh/AGENTS.md`, Canonical record: harvest, and the harvest README (https://github.com/luiul/harvest).
