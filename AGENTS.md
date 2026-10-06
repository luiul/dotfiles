# Dotfiles

## Structure

This repo uses GNU Stow. Each top-level directory is a stow package that mirrors the home directory structure and is symlinked into `$HOME` via `stow <package>`.

Packages: `aws`, `borders`, `brew`, `claude`, `datagrip`, `ghostty`, `git`, `hellofresh`, `hunk`, `karabiner`, `macos`, `pi`, `pig`, `pip`, `rectangle`, `rtk`, `ruff`, `snapzy`, `snowflake`, `sqlfluff`, `ssh`, `stow`, `streamlit`, `sublime`, `vscode`, `worktrunk`, `zed`, `zsh` (`docs/` and `node_modules/` are not packages)

When creating or editing files, place them inside the correct stow package so they end up in the right location when stowed.

## PiG

The `pig` package mirrors the pi setup for [PiG](https://github.com/MichaelKinsy/PiG) (Go port of pi). PiG honors `XDG_CONFIG_HOME`, so its agent dir is `~/.config/pig/agent`. Most files there are relative symlinks into `~/.pi/agent`. Three are stow-ignored snapshot copies: `settings.json` and `auth.json` (pig rewrites settings at runtime), and `mcp-adapter.json` (playwright profile points at pig's own data dir).

Pi is the source of truth and state is shared with it (changed 2026-10-06; before that pig kept its own state on purpose):

- `~/.config/pig/agent/sessions` is a symlink to `~/.pi/agent/sessions`, so both apps read and write one session tree. Pig's old private dir is kept at `sessions.pre-share-bak` (safe to delete).
- `~/.local/bin/pig` (stowed from this package) exports `PI_CODING_AGENT_DIR="$HOME/.pi/agent"`. pi-hermes-memory resolves its whole state root from that variable (`resolveAgentRoot` in `src/paths.ts`), so pig and pi share the memory DB, `MEMORY.md`/`USER.md`/`failures.md`, and `projects-memory`. Pig's old private memory DB (`~/.config/pig/agent/pi-hermes-memory/sessions.db*`) is unused; it held zero memories and is safe to delete.
- Nothing is migrated from pig into pi. Pig side leftovers from before the switch are disposable test data.
- Still separate on purpose: npm state, mcp caches, `models-store.json`, trust, and the three snapshot copies above. `PIG_USE_PI_DIRS` stays unset: it would also force sharing of `settings.json` and `mcp-adapter.json`, which must stay pig specific (pig rewrites settings at runtime; the playwright profile path differs).
- `pig --help` claims "PiG keeps its configuration in ~/.pig and never reads or writes ~/.pi". The symlink and env var above deliberately override that default.

## Workflow

- Leave changes unstaged in the working tree until the user approves them; they review with VS Code's "Open Changes" diff view.
- After approval: stage, commit on `main`, and push straight to `origin/main`. No feature branches or pull requests for this repo (same as other personal projects; HelloFresh repos require pull requests).
- Conventional commit messages (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- IMPORTANT: Do NOT add `Co-Authored-By` lines to commits
