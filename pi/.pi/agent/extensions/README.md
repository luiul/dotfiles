# Pi extensions

## Background resource guard

`resource-budget.ts` supplies a 120-second default for ctx execution tools and rejects background execution without an explicit timeout. It checks the version-pinned context-mode lifecycle patch before every ctx call. A missing or changed patch blocks those tools and points to `pi-resources-patch`. Other tools remain available.

The patch handles cancellation, failed startup, and child process groups. Cancelling a ctx call can also fail sibling calls on the same helper. See [resource safety](../../../../docs/pi-resource-safety.md) for budgets, update recovery, and verification.

```sh
bun scripts/test-resource-budget.ts
bun scripts/test-pi-resource-config.ts
node scripts/test-context-mode-resources.mjs
```

## Agent overview

Orca and Canopy show Pi agent activity. Pi no longer sends desktop notifications. The notification extension and its commands are removed.

## Zsh bang commands (`!!!`)

`zsh-bang.ts` runs `!!!<cmd>` passthrough commands in the interactive zsh instead of bash. Pi's `!`/`!!` passthrough spawns `/bin/bash -c`, which loads no rc files, so zsh functions and aliases (e.g. `gurl` in `funcs_git.zsh`) fail with `command not found`. With the extension, `!!!type gurl` resolves them.

How it works: the TUI strips the leading bangs first (`!!!gurl` parses as `!!` exclude-from-context plus the command `!gurl`), the extension's `user_bash` handler sees the marker bang, and returns `BashOperations` that strip it and spawn `zsh -ic`. Pi's own streaming, Esc cancellation, truncation, and session recording stay intact; only the shell differs. Two consequences of the bang grammar:

- `!!!` commands are always excluded from the model's context (they ride the `!!` prefix). There is no in-context zsh variant.
- `zsh -ic` pays the full interactive zsh config load (~0.6s on this machine, mostly znap cache evals). Fine for occasional shell conveniences; do not use it as a per-call prefix via `shellCommandPrefix`, which would also hit every model `bash` tool call.

stderr from znap's cached fzf eval (`can't change option: zle`, printed because stdin is not a tty) is line-filtered so it never reaches the transcript. A background descendant holding the pipes (`!!!long-job &`) cannot hang the bang UI: after zsh exits, an idle grace timer (3s, re-armed on output chunks, mirroring pi's own waitForChildProcess from earendil-works/pi#5303) closes the streams. All listener/timer cleanup runs in a `finally` block, so a spawn error cannot leak the abort listener or timers. Without the marker bang the handler returns `undefined` and pi's normal bash path runs unchanged.

Verification from the repository root:

```sh
bun scripts/test-zsh-bang-extension.ts
```

The mock harness covers handler routing (marker vs plain commands), marker stripping, real `zsh -ic` execution with the user's config loaded, noise filtering, real stderr passthrough, exit codes, the empty-command hint, abort cleanup (no orphan zsh), and the background-job grace timer (exec returns while the `&` job keeps running). Live check: in a real pi TUI, `!!!type gurl` prints `gurl is a shell function from ~/.zsh_config/funcs_git.zsh` with no zle noise, while plain `!type gurl` still runs bash and fails; `!!!sleep 10 & echo ok` returns `ok` immediately and unblocks the editor (verified 2026-10-19 in tmux, session jsonl asserts `excludeFromContext: true`).

## RTK command rewriting and bash output cap

`rtk.ts` rewrites bash tool commands to their `rtk` equivalents for token savings. The base file is the rtk-shipped pi extension (`rtk init -g --agent pi` regenerates it). All rewrite rules live in the rtk binary: `rtk rewrite` is the single source of truth, the extension only delegates.

Local additions on top of the shipped file (also listed in the file header; re-apply after any rtk sync):

1. Env-prefix-aware rtk detection: `FOO=1 rtk ls` is not re-probed. Idea from [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer).
2. Availability caching: a missing rtk pauses probing for 30s instead of paying a dead exec per bash call, and the extension self-heals when rtk returns (no pi restart). A too-old rtk (< 0.23.0) still disables it.
3. Exit code 2 (rtk denied) surfaces a one-time console warning.
4. Tail-risk cap on bash output: results over 40k chars keep head 24k + tail 12k with an explicit marker. Added after measuring 14 days of sessions: rtk outputs averaged 150 tokens, but one `rtk grep` returned 46k tokens in a single call. It fires a handful of times per month; pi's own 50KB cap stays the outer bound, and read/grep results stay exact.
5. Initial probe deferred to `session_start`: a load-time probe can run before the extension connection is ready, which misreports a healthy rtk as missing and warns at every startup. By `session_start` exec is reliably up; runtimes without the event fall back to a load-time probe. A too-old rtk now disables via a flag checked in the `tool_call` handler instead of an early return, since handlers must register at load before the probe has run.

Why not pi-rtk-optimizer as a whole: it reroutes rtk's stats DB to a temp dir (breaks `rtk gain`), lags pi version support, and its output compaction mostly no-ops on rtk-rewritten commands. Re-evaluation triggers and the adoption checklist live in [issue #22](https://github.com/luiul/dotfiles/issues/22).

Verification from the repository root:

```sh
bun scripts/test-rtk-extension.ts
```

The script drives the real extension with a stubbed ExtensionAPI: rewrite contract, env-prefix detection, `RTK_DISABLED=1`, exit-2 warn-once, timeout-vs-missing handling, 30s re-probe and self-heal, too-old disable, and the bash output cap. A live check additionally runs `pi --no-extensions -e ~/.pi/agent/extensions/rtk.ts --thinking off -p '<prompt that runs a bash command>'` and confirms the rewritten command lands in `rtk gain`.

## Session file changes

`filechanges.ts` tracks which files the agent changed in this session and shows them in a persistent Panel above the editor. Design and vocabulary: [docs/filechanges-design.md](../../../../docs/filechanges-design.md) (implemented in [issue #25](https://github.com/luiul/dotfiles/issues/25)).

Key behaviors:

- One cumulative Session set per session, never reset per prompt. Counts compare against each file's Original while it remains in memory. A Revert forgets both the Change and Original, so later external edits to that reconciled file are not picked up by settlement. A later touch captures a fresh Original.
- Tracks `edit`/`write` at any path. Bash detection uses Git status and command-path snapshots, including paths outside the cwd repo. Bash remains best effort, not a guarantee of authorship.
- The Panel always shows the Session set. A new prompt resets only Prompt activity markers, never the file list. Counts remain cumulative, not per prompt.
- The Panel uses a summary, up to six width-safe file rows, and an overflow hint. Directory prefixes shorten before filename tails. All rows keep the dim gutter, without backgrounds or animations.
- `/filechanges` opens a complete scrollable List with full paths and Repo state. The Panel hides while the List is open and returns on close. Escape closes it. `/filechanges-clear` forgets tracking without changing files. Both take no arguments; Round and Mode filters are retired.
- Repo state refreshes on settlement, Bash results, restore, and `/filechanges`. External staging can remain stale until the next refresh. Routine state yields space to filenames in the Panel; conflicts stay visible.
- Semantic colors distinguish Kind and Counts. Routine Repo state and Prompt activity remain quiet metadata. VS Code through Cmd+E remains the diff review surface.
- The Session set and Prompt activity persist through custom entries. Older entries still load, with saved Mode ignored. Restore rebuilds Originals from HEAD in the cwd repo, so exact first-touch counts after reload are not guaranteed for pre-dirty files.
- Ignore rules, OS temporary-directory exclusions, and binary detection remain. Project `filechanges.ignore` settings override global settings.
- Rendering uses cached state only. No filesystem reads, Git calls, watchers, or polling run in `render()`. Unchanged content skips repeated diff work. Session shutdown releases tracking state and subscriptions.

Verification from the repository root:

```sh
bun scripts/test-filechanges-extension.ts
bun scripts/test-filechanges-components.ts
bun scripts/test-filechanges-tracker.ts
node scripts/test-filechanges-live.mjs
FILECHANGES_BENCH_BASELINE=/path/to/saved/baseline node scripts/bench-filechanges.ts
```

Unit tests use real files and Git repositories. Component tests cover widths, Unicode, caching, theme changes, and complete List scrolling. The real Pi TUI test uses a local model fixture with live Zen, without network model calls. Benchmarks compare cached and invalidated rendering, tracking hooks, settlement, CPU, RSS, and subprocess counts under Pi's Node runtime.

## Compact tool calls (`zen.ts`)

`zen.ts` renders every tool call as exactly one line in the transcript, with a status suffix: `✓ (0.4s)` for success, `✗ <first error line> (2.1s)` for failure (on the native error background, so failures read without expanding). Success and failure are both always visible; the noise (output previews, diffs, content dumps) is hidden until a block is expanded. Click or `ctrl+o` (native, global) expands any block to pi's full native rendering; clicking again or `ctrl+o` collapses it back.

Key behaviors:

- Built on pi's public `pi.registerToolRenderer` API (extensions.md, "Tool rendering"). Zen never walks the transcript layout, never touches component internals, and replaces no renderer: its resolver wraps the native ones and delegates when expanded. Pi's own `read` renderer uses the same compact pattern for skills and docs files (one-line call, empty result while collapsed), so this is a native design, not a hack.
- Per-tool call lines: tools whose native collapsed call is already one line (bash, powershell, read, ls, find, grep) keep pi's own formatting via delegation, with the suffix appended at reduced width (native renderers pad to the full width; appending after a full-width render would push the suffix past the pane edge — measured and fixed). Tools with multi-line native calls (write, edit) get zen's own compact line (`write <path> (N lines)`, `edit <path> (N edits)`). Unknown and MCP tools get a generic one-liner (bold name, condensed args).
- The status suffix rides the shared per-block `rendererState` (the same mechanism the native bash timer uses): the result renderer stores {ok, durationMs, errLine} once the final result arrives and schedules one deferred invalidate (`setTimeout 0`, no synchronous re-entry into `updateDisplay`); the next pass appends the suffix to the call line. Writes happen only on change, so the sequence terminates in two passes (unit-tested).
- Thinking is fully native: the `hideThinkingBlock` setting collapses it, `ctrl+t` peeks per message. Zen v1's thinking code is gone.
- Toggling: `/zen off` returns `next()` unchanged for new blocks and delegates through the wrappers for existing ones, so the off state is byte-exact native (E2E-verified by a line-for-line parity diff against bare pi). `/zen on` refreshes existing blocks through a registry of per-block `invalidate` closures (public `context.invalidate`), cleared on `session_start`, `session_tree`, and `compaction`.
- Fail-open: every native delegation is wrapped; if a pi upgrade changes a renderer's shape, pi's own `updateDisplay` catch falls back to its built-in rendering. Never returns `undefined` into pi's `addChild`.
- Streaming cleanup: after a partial native result, Zen runs the final native result renderer once before hiding its output. This lets the renderer stop its timer without Zen reading private timer fields. The native result component stays separate from the compact empty result.
- Completed reads reuse native call formatting when path, range, working directory, and theme colors are unchanged. Argument and theme changes rebuild the call. The suffix decorator and empty result are reused.
- Generic output keeps two native fallback shapes: registered tools use call and result slots; unknown tools use one framed `Text`. Expanded and toggle-off views are checked against both native shapes, including terminal escape cleanup and image labels.
- Performance checks use actual Pi components, shared renderer state, deferred invalidation, and the same Node runtime as Pi. In seven rotated trials, completed reads took 4.28 µs versus 11.69 µs for bare Pi. Expanded unknown output took 26.06 µs versus 25.10 µs; registered generic output took 69.96 µs versus 69.11 µs. Real TUI startup and streaming remained comparable, with run variation. Three idle checks showed no terminal writes after streaming tools finished. Measurements: https://github.com/luiul/dotfiles/issues/75, https://github.com/luiul/dotfiles/issues/76, and https://github.com/luiul/dotfiles/issues/77.
- Scope: interactive TUI. In other modes the renderers are never invoked, so the extension is inert by construction. Transcript search finds all blocks (nothing is hidden).

Commands and keys: `/zen [on|off]`, shortcut `ctrl+alt+t` (`ctrl+shift+t` is taken by `app.session.tree`). The state persists in `~/.pi/agent/zen.json` (default on); `--zen` / `--no-zen` force it for one session without persisting.

Verification from the repository root:

```sh
bun scripts/test-zen-extension.ts  # 76 checks with fake native renderers
bun scripts/test-zen-components.ts # 29 checks with real Pi components
scripts/test-zen-extension.sh      # real Pi E2E in tmux, seeded with no LLM
node scripts/bench-zen-renderers.ts 2000 7 # actual components, rotated trials
scripts/bench-zen-startup.sh startup bare zen1 # startup wall clock, forced Zen on
```

The E2E asserts: compact start (success one line with suffix, failure one line with error text, native thinking label), native `ctrl+o` expand and collapse, `/zen` off restoring the native transcript, `/zen` on again, `/reload` keeping compact mode, and a line-for-line parity diff between a `--no-zen` capture and a bare-pi capture of the same seeded session. Design and decision history: https://github.com/luiul/dotfiles/issues/67.

## Enhanced status bar

`status-bar.ts` replaces the footer with project and git state, model and thinking level, token usage, cost, and compaction-aware context. Narrow terminals show one compact line. `/statusbar` toggles it.

- Runs only when `ctx.mode === "tui" && ctx.hasUI`. SDK sessions without terminal UI, RPC, JSON, and print sessions have no git polling, footer timers, or compaction settings reads.
- Git refreshes at startup, on branch changes, and every 4s while enabled. One refresh timer also requests rendering. Git commands keep the 2s timeout and use KILL if a child ignores TERM. Concurrent refresh requests share one subprocess slot and coalesce into one pending refresh.
- Disable, repeated startup, and shutdown clear all footer timers and branch listeners. Results from an old session or toggle cannot update the current footer. A git command already running can finish within its existing timeout.
- The 1s working timer runs only during an enabled TUI turn. Enabling mid-turn restores the timer with the original turn start time. Settlement stops it.
- Footer text, colors, width handling, and extension status segments stay unchanged.

Verification from the repository root:

```sh
bun scripts/test-status-bar-resources.ts
# Optional before/after measurement and rendering comparison using an original source backup:
bun scripts/test-status-bar-resources.ts --baseline /tmp/path/to/status-bar.ts
```

The mock harness covers mode guards, toggles, active turns, repeated startup, shutdown, branch changes, git timeouts, subprocess overlap, and stale results. It uses fixed virtual time and starts no Pi sessions. With a baseline source, it also reports 12s SDK and RPC subprocess counts and checks exact footer rendering at narrow and wide widths. Real isolated TUI and headless checks must run separately.

## Bedrock pricing overrides

`pi/.pi/agent/models.json` contains official Bedrock pricing overrides for 54 currently enabled model IDs whose family rates were verified against AWS sources. Route and regional differences are preserved where represented by the installed pi catalog. Configured IDs without verified official pricing are intentionally absent and render as unknown rather than free. Pi reads these natively for its built-in cost display; no extension is involved. The same file also defines the `ai-model-router` provider, so do not delete it.


## AWS SSO auto-refresh (Bedrock only)

`aws-sso-refresh.ts` keeps the `sso-bedrock` AWS SSO session valid so Bedrock model calls never fail with an expired-token error. It validates via `aws sts get-caller-identity` and refreshes through `aws sso login` (browser flow) when needed.

Fully lazy: nothing runs at startup or on model select. The only automatic check is `before_agent_start`, and only when the selected model is on `amazon-bedrock` (throttled to one STS probe per 5 minutes), so an expired session triggers the browser login right before the one call that needs it, never earlier. Sessions on any other provider, such as the AI Model Router, never pay the ~1s probe and never get a surprise browser login. Concurrent processes share one login through a lockfile in tmpdir, and one retry absorbs transient STS failures under contention. `/sso` forces a refresh on demand. The user barely uses Bedrock with pi (AI Model Router is the default), so eager login was removed entirely.

Verification: `bun scripts/test-aws-sso-refresh-extension.ts` (mock harness + fake `aws` binary, asserts no startup/model_select handlers and login only at turn time). Live: put a logging fake `aws` first in PATH, run `pi --no-extensions -e ~/.pi/agent/extensions/aws-sso-refresh.ts --thinking off -p ok` (router default, expect no logged call), then again with `--provider amazon-bedrock --model eu.anthropic.claude-haiku-4-5-20251001-v1:0` and an expired fake state (expect `sts get-caller-identity` x2 then `sso login` x1, no browser).

## Slack auth recovery (HelloFresh): retired

The retired credential-replay Slack MCP server and automatic auth-recovery extension are removed. Prefer an approved, authenticated [official Slack MCP](https://docs.slack.dev/ai/slack-mcp-server) when available to Pi. The managed headed UI reader is the browser fallback, as defined in [issue 41](https://github.com/luiul/dotfiles/issues/41); since 2026-10-12 it lives in `slack-reader` (https://github.com/luiul/slack-reader), with `slack-hf-read` kept as a shim. Do not copy Claude credentials or restore the retired server. Do not switch clients to work around auth loss, access denial, or rate limits.

The browser reader does not capture or replay credentials. Its auth loss pauses reads across Pi runs until explicit UI login verification succeeds. There is no headless fallback, synthetic polling, or fixed cooldown presented as a cure.

A dedicated browser profile does not protect desktop sessions from [Slack Anomaly Event Response](https://slack.engineering/building-slacks-anomaly-event-response/). Report cause as unknown without stronger evidence. If reads correlate with desktop sign-outs, pause Pi Slack access rather than adding evasion. Successful UI checks verify one point in time, not long-term safety.

## ste-lite (lazy Simplified Technical English guard)

`ste-lite/` implements the plan in [issue #12](https://github.com/luiul/dotfiles/issues/12): a small, first-party pi extension that nudges assistant replies and file-edit prose toward ASD-STE100-style Simplified Technical English (short sentences, approved-word swaps, no filler/hedging, no passive-voice walls of text).

### Why not `agent-ste` or `ste-guard`

Both were installed and removed twice in this repo's history (see issue #12). `ste-guard` is a Claude Code plugin whose write guard never fires in pi at all. `agent-ste` has a real pi adapter but is a static linter with always-on hard blocks, which is what made it noisy enough to remove. Neither trigger only on a *degrading* trend, which is the core requirement here.

### How it decides when to act

It is lazy by construction, not just by a low duty cycle:

- `scorer.ts` scores prose deterministically (no LLM calls) against a small ASD-STE100-lite rule set: not-approved-word swaps, sentence length, passive voice, hedging/filler phrases, marketing puffery, and unstructured prose walls. The score is normalized per 100 words.
- `baseline.ts` tracks a rolling per-session baseline (EWMA) rather than a fixed bar. After a short warmup, it only flags a sample as degrading when the score jumps well past that session's own recent baseline, and only intervenes once that holds for three consecutive samples. It uses a slow upward EWMA update for degrading samples, so a consistently wordy session can settle at its own level. A clean sample is required before another intervention, and each channel allows at most three interventions per session. Cross-session history still receives clean samples only, so this adaptation does not change the long-term anti-drift anchor.
- On a confirmed degrade, `scorer.ts#autofix()` applies only meaning-preserving mechanical fixes locally (dictionary word swap, or deleting a filler opener when it is the *entire* first sentence — never a partial prefix, which would leave a dangling fragment). Anything that needs judgment (sentence length, passive voice, hedging) is reported, never rewritten.
- If the mechanical fixes are not enough, a single short (~40 word) reminder is queued and injected once via `before_agent_start` for the next turn only, then cleared. There is no per-turn rule-card injection.

### Does it improve over time?

The per-session baseline in `baseline.ts` alone does **not**: it resets to empty on every `session_start`, and the dictionary in `dictionary.ts` is a hardcoded, frozen list. Left as originally shipped, neither the writing-quality judgment nor the approved-word list would ever get better on their own. Two additions close that gap, both cross-session and both file-backed under `~/.pi/agent/data/ste-lite/`:

- **`history.ts`** persists a running, count-weighted mean score per channel (`history.json`) across every session that ever ran (capped at a rolling window of 500 samples so it stays responsive rather than nearly immovable after months of use). Only samples the baseline did **not** flag as degrading are folded in — this is the load-bearing invariant that makes the mechanism actually improve calibration instead of normalizing bad behavior: if a degrading sample were folded in, a session (or a slow drift across many sessions) that writes worse and worse would drag the historical mean up with it, and a future session just as bad would stop looking degrading relative to that inflated baseline. A new session's baseline is seeded from that clean-only history (`seedBaselineFromHistory`), so a returning session needs far fewer real samples before it can tell degrading from normal-for-you, instead of re-learning from a cold start every time. `/ste-lite history` shows the current running mean and clean-sample count per channel.
- **`candidates.ts`** tallies recurring `style/hedge`, `style/puffery`, and `style/opener` findings across sessions (`candidates.json`), capped at 200 entries. These are the only rules with stable, repeatable excerpts; `length/sentence`, `verb/passive`, and `structure/prose-wall` excerpts are content-derived and would just be one-off noise. `/ste-lite candidates [n]` surfaces the most frequent recurring phrases. `/ste-lite promote <word> <replacement>` lets a human turn one of those into a hard, auto-fixed dictionary entry, stored in a small user-editable overlay (`custom-dictionary.json`) merged with the built-in list at runtime. The approved-word list only grows when a person decides it should, consistent with every rule in `scorer.ts` never rewriting a judgment call on its own.

Both persist incrementally (every 15 scored samples) and on `session_shutdown`, so a crash loses at most a few samples of learning. Writes to every JSON file under `~/.pi/agent/data/ste-lite/` are write-then-rename (never a truncate-in-place), so a crash mid-write cannot leave a half-written, corrupt file behind.

`config.json` also stores the calibration knobs: warmup count, degrade ratio, absolute threshold, streak threshold, degrading EWMA rate, cooldown, and per-channel intervention cap. These values are read on each scored event, so calibration does not require a code edit or reload.

### Known limitation: cross-process races

All of `config.json`, `history.json`, `candidates.json`, and `custom-dictionary.json` are read-modify-write with no lock across processes. Two pi processes flushing at the same moment (plausible: this extension is installed globally, so every concurrently running pi session on the machine shares the same files) can race, and the second write wins — the first process's contribution for that flush is silently lost, not corrupted. This is a real but bounded risk: at most one flush interval (15 observations, or one session) of learning per collision, never data corruption, and the next flush from either process recovers normal accumulation. The known fix pattern is a directory-based mutex with a timeout around the read-modify-write; see Next Steps below.

### Modes and safety

- `~/.pi/agent/data/ste-lite/config.json` holds `enabled`, `mode` (`observe` | `nudge` | `strict`), `scope` (`replies` / `edits`), and the calibration knobs. The current calibrated defaults are a score ratio of 2, absolute difference of 4, a three sample streak, slow degrading adaptation at 0.075, cooldown enabled, and a cap of three interventions per channel per session. These values are read on each scored event, so calibration does not require a code edit or reload. New installs still default to `observe` until the user changes the mode.
- `nudge` applies local autofixes and notifies; it never blocks a tool call.
- `strict` additionally blocks a `write`/`edit` tool call, but only when every finding in the new prose is the single safest deterministic category (`dictionary/not-approved-word` with an unambiguous replacement) — never on a judgment-call rule.
- `STE_LITE_DISABLE=1` fully disables all hooks regardless of config, given the install/remove churn on the two prior tools. `/ste-lite [status|on|off|mode <observe|nudge|strict>|reset]` controls it live, no `/reload` required.
- Every handler is wrapped in try/catch and returns a no-op on any internal error, so a scorer bug can never break the hook chain shared with `pi-hermes-memory` or `context-mode`. Context injection is additive-only (one `before_agent_start` system-prompt append, cleared after use).
- Observations include the session ID, current baseline, top finding rules, score, and intervention decision. The log remains capped at 512KB. This makes later calibration data-driven and separates sessions without reconstructing them from time gaps.

### Verification

```sh
bunx vitest run pi/.pi/agent/extensions/ste-lite-tests/
bun pi/.pi/agent/extensions/ste-lite-tests/replay-observations.ts
pi --no-session --no-extensions -e pi/.pi/agent/extensions/ste-lite/index.ts -p 'Reply with exactly OK.'
```

`replay-observations.ts` is the calibration loop behind the replay numbers below: it replays the real `observations.log` through the production `updateBaseline` / `seedBaselineFromHistory` / `mergeChannelHistory` code under the old defaults, the shipped defaults, and single-lever variants, printing intervention rates, per-session maxima, and the resulting history means, plus a deterministic synthetic wordy-session trace. Re-run it as new logs accumulate; entries with `sessionId` are grouped exactly, older entries use a 45-minute-gap heuristic.

The unit tests cover the scorer (word/sentence rules, prose-span extraction for markdown vs. source-file comments, the autofix safety guards, custom-dictionary overrides), the baseline (warmup, degrade-streak detection, slow upward adaptation, cooldown, per-channel intervention cap, and recovery), the cross-session history merge (count-weighted averaging, the effective-weight cap, warmup seeding), and the candidate tracker (tracked-vs-ignored rules, cross-call accumulation, the entry cap). The print-mode check confirms the extension loads under pi's real extension loader and the `message_end` hook fires without error.

The current replay evidence supports the new defaults. Across the captured observations, the old state machine produced 40.7% reply interventions and 46.4% edit interventions, with worst reconstructed sessions of 49 and 49. The new state machine produced 3.0% reply interventions and 1.8% edit interventions, with worst reconstructed sessions of 3 and 2. The replay used the persisted reply and edit history means as session seeds. The log had five reconstructed sessions and 412 scored observations. This is offline evidence, not a two week live trial.

### Next steps

1. **Cross-process locking.** Add a directory-based mutex with a timeout around ste-lite's `writeJson`/`readJson` so concurrent pi sessions on the same machine stop racing on `history.json`/`candidates.json`/`custom-dictionary.json`. Not urgent (bounded data loss, never corruption), and cheap to implement.
2. **Run the calibrated defaults in `nudge` mode** for two weeks. Review the new session IDs, baselines, finding rules, and intervention counts. Target 5 to 10 percent of scored replies nudging, with no more than three interventions per channel per session.
3. **Review `/ste-lite candidates` periodically** and promote genuinely recurring offenders with `/ste-lite promote`. This is the only way the approved-word list grows. It will not happen on its own, by design.
4. **Decide on `strict` mode** only after `nudge` has run cleanly for a while. It can block a `write` or `edit` on unambiguous not-approved-word findings, including anything promoted via step 3.

## Router per-request image cap

`router-image-cap.ts` keeps requests to the HelloFresh AI Model Router under Baseten's per-request image limit. Baseten rejects requests to the GLM model group with more than 8 images (`litellm.BadRequestError: BasetenException - Too many images: N (max 8)`), and pi resends the full transcript every turn, so image-heavy sessions permanently 400 once accumulated images cross the limit.

Before each LLM call, the `context` handler counts image parts across the transcript. Over the cap, it keeps the most recent 8 images and replaces the oldest ones with a text placeholder naming the source path (resolved from the matching `toolCall` arguments, e.g. the `read` tool's path), so the model knows an image existed and can re-read it. The `context` event is request-local: pi restores the transcript afterward, so session logs keep every image and only the outgoing request is trimmed. Originals are never mutated; changed messages are shallow copies.

- Scope: only models on the `ai-model-router` provider. Direct Bedrock and others keep full image history. No model, no trimming.
- Cap: 8, override with `PI_IMAGE_CAP_MAX=<n>` (also used by the tests). `/image-cap` shows the active cap and whether the current model is scoped.
- One TUI notice per changed drop count, not per request: within a run the same images are trimmed on every LLM call, so per-request notices would spam. Subagent and print sessions trim silently (`ctx.hasUI` guard).
- Handlers are wrapped in try/catch: a trimming bug can never break the request chain; worst case the pre-existing 400 behavior returns.

Verification from the repository root:

```sh
bun scripts/test-router-image-cap.ts
```

The mock harness covers cap math (keep the N most recent), placeholder text and source paths, provider scoping, transcript immutability, notify dedupe, string content, and the env override. Live check: `pi --no-extensions -e ~/.pi/agent/extensions/router-image-cap.ts --thinking off -p 'Reply with only the word COUNTED.' @img1.png ... @img11.png` in a dir with 11 tiny PNGs. Without the extension that request 400s with the exact Baseten error; with it, the model replies (verified 2026-10-15 against the live router).

## Bedrock GPT 5.6 reasoning

`bedrock-openai-reasoning.ts` is a compatibility extension for OpenAI GPT 5.6 models invoked through Amazon Bedrock's Converse API.

### Why it exists

Pi 0.84.2 correctly exposes reasoning capable GPT 5.6 models and advertises `xhigh` in the model catalog, but its Bedrock adapter only adds reasoning request fields for Claude models. Without this extension, selecting `high`, `xhigh`, or another thinking level changes pi's local state but does not send GPT 5.6's effort parameter to Bedrock.

### How it works

Before each provider request, the extension checks the active model ID for `openai.gpt-5.6-`. For a matching model, it reads pi's effective thinking level and returns the request payload with this Bedrock Converse field merged in:

```json
{
  "additionalModelRequestFields": {
    "reasoning": {
      "effort": "xhigh"
    }
  }
}
```

The mapping is:

| Pi level | Bedrock effort |
| --- | --- |
| `off` | `none` |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

It only changes GPT 5.6 Bedrock payloads. Other models and providers are left untouched. It also preserves any existing fields in `additionalModelRequestFields` and any other provider payload fields.

### After changing the thinking level

Use `/reload` after installing or editing the extension. Then select the desired thinking level and send a prompt. The current effective level is available to shell commands as `PI_REASONING_LEVEL`.

### Verification

To verify the extension is present and pi can load it:

```sh
pi --list-models | grep 'gpt-5.6-luna'
```

For a payload level check, temporarily add a `console.log(JSON.stringify(event.payload))` line inside the `before_provider_request` handler, run one small prompt, and remove the logging afterward. Do not leave request payload logging enabled because prompts and tool definitions may contain sensitive data.

## Open cwd in VS Code

`open-vscode.ts` binds `super+e` to open the session's working directory in VS Code via `pi.registerShortcut()` (works mid-turn, shows up in `/hotkeys`). It opens `ctx.cwd`, deliberately not the git repo root: pi sessions are often started inside a dbt project subdir of the global-ops or tardis monorepos on purpose, and the shortcut must open that same scope, not the monorepo root. `code` is spawned detached, so pi never waits and an already-open folder just gets focused. `super` keys require the Kitty keyboard protocol, which ghostty provides; the only other `super` binding in use is `super+c` (`app.message.copy`).

Verification: `pi --no-extensions -e ~/.pi/agent/extensions/open-vscode.ts` inside tmux, run `/hotkeys`, confirm `super+e` is listed, then press `Cmd+E` in ghostty and confirm VS Code opens the session directory.

## What to do after updating pi

The extension is stored in this dotfiles repository, not inside pi's installed package. A normal pi update should not delete it.

Since pi 1.4.0, pi self manages its install under `~/.pi/agent/install/releases/<version>` (`pi update` installs a new release there). `~/.pi/agent/install/current` is a local symlink to the active release, created by hand: the dev module links in `~/dotfiles/node_modules` and the adapter inspection path below go through it, so after `pi update` refresh it first:

```sh
ln -sfn "releases/$(cat ~/.pi/agent/install/current-version)" ~/.pi/agent/install/current
```

After updating pi:

1. Restart pi or run `/reload`.
2. Run `pi --list-models | grep 'gpt-5.6-luna'`.
3. Check that pi still loads `pi/.pi/agent/extensions/bedrock-openai-reasoning.ts` through `~/.pi/agent/extensions/bedrock-openai-reasoning.ts`.
4. Test one small GPT 5.6 request with `xhigh` selected.
5. If a newer pi release natively supports GPT 5.6 Bedrock effort, remove this workaround only after confirming the native payload behavior. Otherwise, keep it.

Do not edit the installed files inside `~/.pi/agent/install/` (pi's self managed install since 1.4.0; the old `/opt/homebrew/lib/node_modules` package is gone). The source of truth is this file in dotfiles. The live extension path is a symlink created by GNU Stow or the equivalent dotfiles setup.

To check whether the workaround is still needed, inspect the installed adapter for GPT 5.6 handling:

```sh
grep -n -A80 'function buildAdditionalModelRequestFields' \
  ~/.pi/agent/install/current/node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js
```

(In the 1.4.0 managed layout, `pi-ai` is a flat sibling of `pi-coding-agent` under `@earendil-works/`, no longer nested inside its `node_modules`.)

If the adapter natively emits `additionalModelRequestFields.reasoning.effort` for OpenAI GPT 5.6 models, disable or remove this extension to avoid duplicate ownership of the behavior. The extension merges the field safely, but native support is preferable.
