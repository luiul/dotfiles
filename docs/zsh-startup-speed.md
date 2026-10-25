# Zsh startup speed (SentinelOne workaround)

Why new terminal windows felt slow, what we changed on 2026-10-11, and how to fix or revert the setup if it breaks.

## Symptom

A new login shell (what Ghostty opens) took ~1.1s cold and ~0.85s typical to reach a prompt.

## Root cause

SentinelOne (corporate endpoint security, IT managed) taxes every process spawn by ~250ms cold / ~60ms warm, with zero CPU consumed. Measured: `zsh -fc true` = 0.25s, `/usr/libexec/path_helper -s` = 0.26s, `python3 -c pass` = 0.66s, while trivial binaries are instant. The startup chain spawned four taxed processes serially:

1. zsh itself (unavoidable).
2. `path_helper`, run by `/etc/zprofile` for login shells.
3. `locale`, run by `/etc/zshrc` (stock Apple file) for interactive shells.
4. A child zsh via zpty, spawned by `znap source` on every startup just to check the plugin repo exists.

The dotfiles themselves were never the problem: all of `.zsh_config` costs ~10ms, the znap eval caches are zcompiled and cost ~20ms total.

## What changed

1. `zsh/.zshenv` (new file, stowed to `~/.zshenv`): `unsetopt GLOBAL_RCS` skips `/etc/zprofile` and `/etc/zshrc`, removing spawns 2 and 3 (~0.5s). A `path` array in the same file replicates path_helper's output from `/etc/paths` and `/etc/paths.d`, so PATH is byte-identical to before (verified by diff). Cargo is sourced before the array so `~/.cargo/bin` keeps its old position near the end of PATH.
2. `zsh/.zshrc`: zsh-autocomplete is sourced directly (`~/repos/marlonrichert/zsh-autocomplete/zsh-autocomplete.plugin.zsh`) instead of `znap source`, removing spawn 4 (~0.26s). znap stays for the `znap eval` caches, which are cheap.
3. `zsh/.zshrc`: the trailing `compinit` call was removed. zsh-autocomplete runs compinit itself (async). A `compinit -C` fallback runs only if the plugin is missing. Also added `setopt COMBINING_CHARS`, the one useful setting `/etc/zshrc` had.
4. `zsh/.zsh_config/path.zsh`: comment only, points to `.zshenv` for the base paths.

Result: warm startup 0.09 to 0.5s → ~0.06s. Cold start should drop from ~1.1s to ~0.35s (three taxed spawns removed); cold numbers could not be re-measured right after the change because SentinelOne caches exec verdicts and everything was warm.

Verified live in real Ghostty windows by replicating Ghostty's exact launch env (`ZDOTDIR=<Ghostty resources>/shell-integration/zsh`, which sources `~/.zshenv` before globals would run): `options[globalrcs]` is `off`, PATH identical, completions, fzf, zoxide, syntax highlighting all load.

## Async git prompt, then gitstatusd (2026-10-11 follow-ups)

`prompt.zsh` used to run `git status --porcelain=v2 --branch` synchronously on EVERY prompt render: one taxed spawn per prompt, ~270ms in git repos (0.005s CPU, pure spawn tax). Two-stage fix:

1. Async subshell: a precmd hook forks a background subshell that runs plain `git status`; a `zle -F` fd watcher applies the segment via `zle .reset-prompt` (~1.4ms render, info pops in ~0.3s later, can be one render stale).
2. gitstatusd (current): `~/repos/gitstatus` (romkatv/gitstatus, daemon binary in `~/.cache/gitstatus`) answers git segment queries in-process over zpty, no per-render exec. `gitstatus_start` costs one taxed exec (~0.4s cold), so it is deferred to idle time with `sched +2` / `sched +10`; until the daemon is up (or if it fails), the async subshell path covers the segment. The daemon query runs in precmd because my_prompt executes inside `$(...)` and cannot set variables. Segment output is byte-identical to the old path (verified for dirty tree, ahead, stash, detached HEAD with tag and sha, and MERGING).

Exit code survives in `_my_prompt_last_exit` because `$?` is not reliable during async redraws. A `took Ns` duration segment (threshold 3s, `1m05s` over a minute) times commands via EPOCHREALTIME in preexec/precmd; note `int()` does not exist in macOS zsh arithmetic, use integer-typed vars to truncate.

Verified in tmux: parity of both segment builders, fallback pop-in before daemon start, typed buffers survive redraws, no fd leaks, no flicker with zsh-autocomplete, duration and exit indicator correct.

Result: new window in a git repo ≈ 0.3s to usable prompt (was ~1.35s); per-command cost ~3ms (precmd with daemon query + render, was ~270ms); zero git execs per render (was one per render).

Note when testing speed: always use a brand-new window or tab. The Ghostty quick terminal reuses its original session, so it never re-runs startup. gitstatusd needs a tty (job control): in non-tty shells it fails to start and the async fallback covers the segment. Update gitstatus: `git -C ~/repos/gitstatus pull` (binary cache survives).

## Current setup (2026-10-25)

The latest review removed repeated completion generation and kept Git work off the input path.

- Mole completions use a Znap cache. The executable path and modification time invalidate the cache after an update. Both `mole` and `mo` keep their completion bindings.
- The orphan guard uses Zsh's `ZSH_EXECUTION_STRING` instead of spawning `ps` and `grep` for command-only shells. The no-TTY protection remains.
- The prompt is assembled in the main shell. Rendering no longer uses `PROMPT='$(my_prompt)'` or starts a subprocess on each redraw.
- Normal Git repos use asynchronous daemon queries. A pending query never blocks typing. Late results cannot overwrite the current directory or command generation.
- The daemon starts only when a normal repo needs it. Its executable starts asynchronously. A pipe-readiness callback completes the handshake with a 50 ms bound and at most three attempts per shell. Home directories and filtered repos need no daemon.
- Repos with clean or process filters use background Git. Filter decisions expire after 30 seconds. Content changes to local or global config invalidate them sooner, even if size and modification time stay unchanged. Pending daemon results recheck the original config snapshot before publishing. Config files above 64 KiB always use background Git.
- Workers publish complete newline-delimited records. The callback uses nonblocking reads, so partial results cannot freeze input. Replaced workers and their process groups are cancelled. A five-second deadline marks unavailable status as `git:?`, not clean.
- Completed worker and daemon timers are removed. Shell exit closes descriptors and stops background work.

### Prompt information

The layout still shows time, directory, branch or detached ref, upstream ahead/behind counts, stashes, operation state, staged changes, unstaged changes, untracked files, active virtual environment, failed command status, and commands taking at least three seconds.

Conflicts now have a separate `!N` count. Type changes count as modified. Both status paths count renames as deletion plus addition. Linked worktrees read stashes from the common Git directory. Submodule commit changes count, but dirt inside a submodule does not. An active virtual environment stays visible outside its project.

Branch, tag, and environment labels escape prompt-percent sequences. Shell substitution stays off, so labels cannot run shell commands. Window titles remove terminal control characters and resolve relative Git pointers correctly.

### Measurements

These are local measurements from the same review. Endpoint-security caches and machine load cause variation. They are not cold-boot guarantees.

| Check | Before | After |
|---|---:|---:|
| Fresh login shell, median of 7 warm runs | 311 ms | 45 ms |
| Shell start to first prompt hook in tmux, median | 358 ms | 88 ms |
| Real Ghostty shell start to first prompt hook, interleaved median of 3 | 468 ms | 84 ms |
| Actual window request to first command, median of 5 | 814 ms | 747 ms |
| Prompt rendering | 1.17 ms | 0.011 ms |

The window-request measurement includes AppleScript and window creation. The shell-start measurement isolates the startup config. Both real Ghostty cases used new windows, not the reused quick terminal. Completion registration was ready at the first prompt hook in the instrumented shells. PATH stayed byte-identical.

A repeat check in the isolated worktree compared the committed startup config with this change. Seven interleaved login-shell samples measured 303 ms before and 47 ms after. Three interleaved real Ghostty samples measured shell startup at 400 ms before and 85 ms after. Window request to first command measured 637 ms before and 317 ms after, including automation. PATH stayed identical, and both Mole completion names were ready at the first prompt. Existing Ghostty windows stayed open.

### Checks

Run these after changes:

```sh
zsh scripts/test-git-prompt.zsh
zsh scripts/test-zsh-startup.zsh
bun scripts/test-git-prompt-live.ts
zsh scripts/test-cod.zsh
zsh scripts/test-orca-watch.zsh
git diff --check
```

The live suite uses a private `ZDOTDIR` and this checkout's config through `ZSH_CONFIG_DIR`. It never uses another checkout's stowed prompt. Test sessions have registered owners and deadlines. The suite checks real login shells, Mole Tab completion, Git live completion, failure codes, duration, slow-worker typing, cancellation, deadlines, and shutdown cleanup. The fixture suite checks type changes, rename counts, conflicts, escaped labels, linked worktrees, window titles, stashes, cache invalidation, config races, and asynchronous query identity.

## If something breaks

- Tools not found or wrong PATH: check `echo $options[globalrcs]` prints `off`, then compare `echo $PATH` against the array in `zsh/.zshenv`. If IT adds a file under `/etc/paths.d`, add its entries to that array.
- Completions broken: check the plugin still exists at `~/repos/marlonrichert/zsh-autocomplete`. If it was deleted, either re-clone it or remove the source block in `.zshrc`. The `compinit -C` fallback then provides basic completions.
- A completion cache needs refresh after a tool update: Mole checks its executable automatically. Other generated completions retain the existing Znap cache behavior.
- A Git filter was changed through an included config file: allow 30 seconds or open a new shell. Direct local/global config content and branch changes invalidate immediately.
- Prompt shows `git:?`: a background Git query exceeded its five-second deadline. Check `git status` directly. The next command retries.
- Shell errors on startup mentioning `.zshenv`: the stow symlink may be stale. Re-run `cd ~/dotfiles && stow -R zsh`.

### Full revert

1. In `zsh/.zshenv`: delete `unsetopt GLOBAL_RCS` and the `path=(...)` array. Keep the cargo line.
2. In `zsh/.zshrc`: replace the direct-source block with `znap source marlonrichert/zsh-autocomplete`, and restore `autoload -Uz compinit` + `compinit` at the end.
3. `cd ~/dotfiles && stow -R zsh`.

A copy of the pre-change `.zshenv` is at `~/.zshenv.pre-stow-bak` (it only contained the cargo line).

## Known trade-offs

- `/etc/zshrc` also set history defaults (ours live in `.zsh_config/history.zsh`), terminfo key bindings (our config sets its own), and sourced `/etc/zshrc_Apple_Terminal` (only used by Terminal.app, which we do not use).
- MANPATH from path_helper is not replicated; `man` finds Homebrew manpages via PATH anyway.
- macOS or IT changes to `/etc/paths` and `/etc/paths.d` no longer apply automatically. Sync the `.zshenv` array manually.
- To update zsh-autocomplete: `git -C ~/repos/marlonrichert/zsh-autocomplete pull`.

## Re-benchmarking

Run in bash (not zsh): `TIMEFORMAT='%R s'; for i in {1..5}; do time /bin/zsh -l -i -c exit; done`. Expect ~0.3 to 0.4s cold, ~0.06s warm. Caveats: `/usr/bin/time` with an env assignment prefix mis-measures in sandboxes (reports 0.00s), and SentinelOne caching makes identical runs vary 3x, so only compare before/after within one session. For per-line hotspots use an xtrace with timestamps: `zmodload zsh/datetime; setopt PROMPT_SUBST XTRACE; PS4='+$EPOCHREALTIME %N:%i '` from a temp `ZDOTDIR` wrapper that then sources `~/.zshrc`.
