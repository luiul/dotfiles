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

## compact tool calls

The `zen` extension's compact view of tool calls in pi's transcript. Successful and failed calls stay visible as one line with a status suffix. Click or `ctrl+o` expands tool output. Zen uses the public `pi.registerToolRenderer` API and delegates to native renderers when expanded or turned off. Thinking uses pi's native `hideThinkingBlock` setting. This view replaces the retired split extension and zen v1's transcript filter.

Source: `pi/.pi/agent/extensions/zen.ts`, `pi/.pi/agent/extensions/README.md`, and https://github.com/luiul/dotfiles/issues/67.

## zen toggle

The switch for compact tool calls: `/zen [on|off]` or `ctrl+alt+t`. The state persists in `~/.pi/agent/zen.json` (default on). `--zen` and `--no-zen` force it for one session without saving. The toggle changes existing tool blocks as well as new ones. Native `ctrl+t` controls thinking independently.

Source: `pi/.pi/agent/extensions/zen.ts`.

## orphan process

A process whose original owner has exited. Parent PID 1 alone does not prove abandonment, because launchd jobs and managed services can have that parent. The watchdog checks the executable, user, start time, and expected role before signaling it.

Source: `macos/.local/bin/reap-strays.mjs` and `docs/pi-resource-safety.md`.

## resource budget

A limit on an agent's work or a tool's execution time. Pi's agent limits apply per session. An execution timeout bounds foreground work. Background work also needs an owner and an explicit shutdown step.

Source: `pi/.pi/agent/subagents.json`, `pi/.pi/agent/extensions/resource-budget.ts`, and `docs/pi-resource-safety.md`.

## harvest

The local Business Impact database for Jira tickets and GitHub PRs: DuckDB + Apache Iceberg stored under `~/.harvest/` (repo: `~/projects/personal/harvest`, CLI: `harvest`). Harvest is the source of truth for all six impact fields; the Jira ticket and the GitHub PR are projections. Jira and GitHub are the sources of truth for lifecycle, which `harvest sync` ingests.

Source: `~/projects/hellofresh/AGENTS.md`, Canonical record: harvest, and the harvest README (https://github.com/luiul/harvest).
