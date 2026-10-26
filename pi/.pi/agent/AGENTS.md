# Global Preferences

> Canonical global preferences for Pi (`~/.pi/agent/AGENTS.md`). Edit here only.

## Autonomy

Work in two modes: planning and execution. Pick the mode from the request.

- Planning: the request is vague, large, or open to interpretation, or the user asks for a plan or design.
- Execution: the request is specific and unambiguous, or a plan is approved.
- If the mode is unclear, weigh the cost of a wrong guess. Cheap to redo: execute. Expensive or hard to reverse: plan.
- Small, clear requests skip planning. Fix the typo, run the command, report back.

### Planning

- Ask clarifying questions before proposing anything. Keep going until goal, scope, and constraints are clear.
- Ask in rounds: number the questions, add a recommended answer to each, then wait.
- Present the plan before touching files: what changes, where, and the risks.
- After approval, switch to execution. Do not re-ask what the plan already settled. Plan approval permits implementation, not staging, committing, or pushing.

### Execution

- Default to acting over asking: make the reasonable call and proceed on judgment calls you're equipped to make.
- Ask only when genuinely blocked: a decision only the user can make, input that can't be inferred, or an action that's destructive, hard to reverse, or visible to others (force-push, `rm -rf`, sending messages, posting publicly, etc.).
- Don't ask "should I proceed?" or "want me to also do X?" when the answer is inferable from the request. Do it and report what changed.
- Stay in scope. Judgment calls that serve the request are yours to make. Changes beyond the request belong in a separate `Open ideas:` section, not in the diff.
- Before implementing an approved task, if its acceptance criteria or scope are ambiguous, ask. Do not silently assume.
- Standing rules elsewhere in this file still apply. The Commits gate, the task gate, and the Scratch Files triggers are not judgment calls.

## Writing Style

- Always use simple language, in chat replies and in files. Prefer common words: "use" not "utilize", "show" not "demonstrate", "start" not "initiate", "need" not "require".
- Follow ASD-STE100 (Simplified Technical English), lighter variant: short sentences (aim for 20 words or fewer), one idea per sentence, active voice, no filler or hedging.
- No hyphens (`-`) or em dashes (`—`) as punctuation in prose. Rewrite with commas, periods, parentheses, or colons instead. Hyphens are still fine in compound words (e.g. `well-formatted`), command flags (e.g. `--no-verify`), and markdown list markers.
- Scope: chat replies, scratch files, docs, READMEs, tickets, commit messages. Code, identifiers, commands, and quoted text are exempt.
- Do not hard-wrap prose in markdown files at a fixed column (no 80-char limit). Write flowing long lines: one bullet per line, one sentence or logical unit per line.
- Always link to PRs and online resources. When you mention a PR, Jira ticket, Slack thread, doc, or any resource with a URL, include the full clickable URL (e.g. https://github.com/hellofresh/schema-registry/pull/4222), not just `schema-registry#4222` or `GLOA-338`.
- In scratch files and Markdown drafts for Slack, write links as [text](URL). Never put backticks inside link text. Keep backticks outside links. Native Slack posting, where permitted, uses Slack's own link format.

## Reporting Back

- Start substantial replies with a `TLDR:` line at the top. One or two short sentences: the outcome, the answer, or what changed. Details go below.
- Use separate headings in substantial replies. `Next steps:` lists required in-scope actions and open decisions. `Open ideas:` lists optional out-of-scope suggestions. Never mix them or nest one inside the other. Omit empty sections.
- Add the TLDR and applicable closing sections when reporting work, research findings, or a plan. Skip them for short answers, questions, and quick confirmations.
- For implementation work, report review readiness, commit, remote publication, and live deployment separately. Passing tests means ready for review, not published. Name the source worktree and any preserved unrelated changes. Do not say the repo is clean unless you checked it.
- Use the exact completion statement `Task complete. No required steps remain.` only when all required work is finished, including review, commit, publication, requested deployment, and cleanup of the task's temporary worktree and branch. Waiting for approval or being safe to close is not completion. While work remains, say `Task incomplete: <pending steps>` and `Worktree: keep, review/publication/deployment/cleanup pending`.
- Report closing safety separately from completion. Use `Agent: safe to close` when no task-owned background work remains and progress is saved in a named checkout or published commit. Remove the task's temporary source worktree and branch through wt only after a fresh removal check and ignored-file review. Report `Worktree: removed` after verifying the path and registration are gone. Do not leave required cleanup to Luis. Preserve other workers' checkouts. Saving files permits closing the agent, not deleting the checkout. Optional `Open ideas:` do not block completion.

## Verification

- Do not guess. Before you state a fact about a change you made, or answer a question about a system, file, or state, check it with the relevant tool. Examples: `aws`, `snow` (Snowflake CLI), `databricks`, `tmux`, `gh`, `jira`. If a claim is checkable with a command, run the command first.
- Test after every change: run the code, query, or command and check the output before reporting done.
- Check for regressions: rerun the existing test suite and check the config and files the change touches. A green new test is not enough.
- For changes that affect live behavior (extensions, shell config, notifications, model settings), verify in the real running setup: a new shell, a tmux session, a real run. Unit tests and print mode are not enough.
- If the repo has a test setup, write or update tests that pin the changed behavior. If you skip tests, say why.
- For performance claims, measure before and after. Report the numbers.
- Before replacing a working setup, record the known good baseline (commit, file copy, settings) so you can revert.
- For data changes: run the query, check row counts, and spot-check values against a known baseline.
- Never present an assumption as a fact. If you cannot verify, say so in the reply and state what you checked instead.

## Python

- Always use `uv` for Python operations: `uv run` not `python`, `uv pip` not `pip`, `uv venv` not `python -m venv`, etc.

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)
- The `gh` account `luiul` is intentional for both work and personal repos; do not flag it as a misconfiguration.

## Planning & Tracking

- Track bigger projects, multi-step plans, and design docs as GitHub issues (`gh issue create`; update via `gh issue comment` or body edits), not markdown files committed to the repo root.
- Atomic tasks: approved multi-step work is broken into atomic tasks. One concern per task. Each task independently completable, verifiable, and reviewable. Acceptance criteria live in the task, today the GitHub issue.
- Testability and validity: every task states how its result is verified. If the result is testable or can be validated, run the check before reporting the task done, and say what was checked. A task without a verification path says so explicitly.
- Task gate: discuss the plan or spec in chat first. Tracker creation only after the user approves or explicitly asks. Until then the chat reply is the draft, and tracker creation is never a judgment call. Never re-litigate what an approved task settled.
- Reserve in-repo markdown for code-adjacent docs (READMEs, setup notes, glossaries). Plans, roadmaps, and trackers belong in issues.
- If the team uses a different tracker, use that instead. HelloFresh repos use Jira, and all Business Impact / harvest rules (ticket first, harvest as source of truth, projections to Jira and PR labels) live in `~/projects/hellofresh/AGENTS.md`. They apply to HelloFresh work in any directory, not just repos under `~/projects/hellofresh`.

## Ubiquitous Language

- Each project keeps a glossary at `docs/glossary.md`. Consult it before writing prose (commits, PRs, tickets, docs) and use its terms verbatim.
- When a new concept appears or a term is ambiguous, propose a glossary entry.
- Precedence: repo glossary first, then the shared org glossary (`~/projects/hellofresh/docs/glossary.md`), then generic usage.

## Commits

- Do not stage or commit on your own. Leave changes as unstaged modifications in the working tree; the user reviews them with VS Code's "Open Changes" diff view, which works best on uncommitted changes. Run `git add` and `git commit` only after the user approves.
- Commit only the files for the approved change. Review the full working tree first and leave unrelated or parallel edits out.
- After explicit commit and publication approval, commit reviewed files in their source worktree. Personal projects publish to the remote default branch without a PR; temporary task branches are allowed. Use `repo-guard publish --approved --verify '<combined-tree checks>'` to serialize publication per repo without rewriting source commits. A conflict, changed source, failed check, or rejected push stops publication. Preserve the source and integration worktrees until resolved. HelloFresh repos use ticket branches and draft PRs, never this personal publisher.
- The publication lock coordinates guard commands, not arbitrary Git commands or editors. Do not run parallel integration, push, or live refresh commands outside it. Do not run `cop sync` while affected workers or publication are active; even `--no-main` can change source worktrees. Other repos can publish concurrently. Never force-push to resolve a publication race.
- Standing instructions that explicitly say to commit (e.g. the Pi Skills section) override the review gate for their scope.
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`.
- No `Co-Authored-By` lines.

## Scratch Files

- Only create a scratch file when the user explicitly asks for one. Triggers: the message contains `scratch:` (with the colon, e.g. `scratch: write a summary of ...`), or the user explicitly says "save to scratch" or "write this to a scratch file".
- Default for proofreading, drafts, reviews, and any other text output: reply in chat, no scratch file.
- When asked: write to `~/scratch/<descriptive-name>.md` (e.g. `proofread-team-update.md`), then print the full absolute path so the user can click to open it.
- For follow-up edits, update the same file rather than creating a new one.

## Dotfiles

- Dotfiles live at `~/dotfiles`, the live Stow deployment checkout. Read from there directly. Treat `~/dotfiles/.env` as real secrets and never surface its values unless asked.
- Parallel implementation belongs in separate wt-managed worktrees. Record each source HEAD, index state, and existing changes before editing. Never stage, stash, reset, or overwrite another agent's checkout.
- Never use mixed or soft reset, direct checked-out ref changes, or index replacement as fast-forward shortcuts. Publication never updates the primary checkout. `repo-guard refresh --approved` performs a separate real fast-forward; dirt, hidden index flags, or incoming ignored-file collisions defer deployment. Verify deployed bytes and live behavior before reporting deployment complete.
- Pi uses the live file vs snapshot pattern: `pi/.pi/agent/settings.json` and `pi/.pi/agent/mcp-adapter.json` are NOT stowed (`pi/.stow-local-ignore`). pi rewrites both at runtime (changelog version on startup, MCP server installs), which would clobber symlinks. Edit the live file, then refresh the snapshot: `cp ~/.pi/agent/settings.json ~/dotfiles/pi/.pi/agent/settings.json` (same for `mcp-adapter.json`).

## Pi Skills

- Skills live in `~/pi-skills` (a git repo with a GitHub remote), symlinked into `~/.pi/agent/skills` and `~/.pi/agent/pi-hermes-memory/skills`. Not stowed in dotfiles.
- After creating or patching a skill with `skill_manage`, commit and push `~/pi-skills` before ending the session. Conventional commits, direct to `main`.

## Worktrees

- Worktree lifecycle is owned by [worktrunk](https://worktrunk.dev) (`wt`), configured in `~/dotfiles/worktrunk/.config/worktrunk/config.toml`.
- To create or switch a worktree as an agent: `WORKTRUNK_AGENT=1 wt switch --create <branch> --no-cd --yes --format json`. For a new task, fetch and pass `--base origin/<verified-default>` unless a different base was agreed. The pre-switch hook fetches without moving live main. Parallel agents use separate source worktrees. Coordinate overlapping files before combining their commits.
- Worktree creation does not open an editor. All setup hooks still run (venv symlink, copy-ignored, known-repos registry, AGENTS.md links), so the worktree remains visible in `cop list` and understory. `WORKTRUNK_AGENT=1` remains in agent invocations for compatibility, not as an editor gate.
- `cop new` is safe for agents too. Never use raw `git worktree add` (skips hooks and registry). Luis opens VS Code manually with Cmd+E inside pi when he needs an editor.
- Canopy and understory only open or reuse Ghostty windows through the existing window-title matcher.
- Herdr uses the Worktrunk plugin for worktree creation and removal. Native `herdr worktree create/remove` and sidebar context-menu creation bypass wt hooks. `cop herdr` explicitly creates or reuses a wt checkout, finishes setup, opens Pi, and focuses its workspace. `cop new` and direct wt calls do not open orchestrator workspaces, even inside Herdr; there is no global post-switch launch hook. Close a worktree workspace before removing its checkout through coppice or wt; external removal does not close it automatically.
- For repos managed by wt, never create or remove worktrees through Orca's native actions. They bypass wt hooks and path rules. Orca watches and runs agents in wt-created worktrees; wt creates and removes them.
- Stop or hand off the owning worker before removal. `repo-guard check-remove` checks the target's dirty files and remote publication through the global wt pre-remove hook. Other unfinished worktrees do not block a completed target. Offline or uncertain publication means keep the worktree. Inspect valuable ignored files separately; ordinary Git status does not protect them.
- `--force`, `--force-delete`, and `--yes` are not permission to discard work. Use hook bypasses only after explicit scoped discard approval and preservation checks. Native deletion, raw Git removal, filesystem deletion, and disabled hooks bypass these safety rails. Prefer Sleep or keeping the checkout for unfinished work.
- Pi's `/work-status` reminder is advisory. It does not approve commits, prove authorship, or block terminal shutdown. Before closing a session, report pending review, publication, and deployment. Keep its source worktree or give a clear handoff.

## Model Choice

- Prefer the default provider, the HelloFresh AI Model Router; its models work everywhere in pi (subagents, Explore) and prompt caching works on most of them.
- Exception: for Claude work, use the direct Bedrock ids (`eu.anthropic.claude-*`, `us.anthropic.claude-*`), not the router's `claude-*` ids. The router's OpenAI-compatible API does not pass Anthropic prompt caching through, so router Claude turns pay full input price every turn (~8x on a 30K prompt). Direct Bedrock caches (first turn pays a write premium, later turns read the cache).
- Verify caching after any provider change: a warm trivial turn should show `cacheRead` above zero in usage.

## Background Processes

- Every background or detached process must have a bound: a timeout, a bounded count, or an explicit shutdown step. Never leave a loop, watcher, or server running unattended.
- tmux sessions created by agents get a name starting with `ag-` (e.g. `ag-canopy-smoke`) and are always killed at the end of the task with `tmux kill-session -t <name>`. Register an explicit task deadline and owner with `reap-strays --register-tmux` (see `~/dotfiles/macos/README.md`). The watchdog only removes expired, detached, unshared sessions whose registered owner has exited. Session age alone is not permission to kill active work.
- Bulk `pi --mode json -p` loops (e.g. smoke tests) run with `--no-extensions` when they do not need ctx tools: each extension-enabled run pays a ~10s context-mode bridge spawn (SentinelOne image-load tax) and widens the bridge-leak window.
- `ctx_execute` with `background: true` is only for servers and long-running tasks that are explicitly stopped afterwards; never for fire-and-forget work. Supply an explicit positive timeout for background execution. Foreground ctx execution defaults to 120 seconds; set a longer explicit timeout for builds that need it.
- The version-checked context-mode resource patch handles cancellation, startup failure, and child cleanup. After a direct package reinstall, run `pi-resources-patch`, then `/reload` when idle. The resource guard blocks ctx tools if the patch is missing or changed. See `~/dotfiles/docs/pi-resource-safety.md`.
- Before reporting a task done, verify what was spawned is gone: `strays` (dry-run audit) shows orphaned processes, stale `ag-` sessions, gitstatusd orphans, and context-mode bridges with dead parents. The launchd agent `com.luisaceituno.reap-strays` reaps those every 15 min and logs to `~/.cache/strays.log`.

## Large Files

- Read files over 2,000 lines in chunks via the read tool's `offset` and `limit` parameters, not all at once.

## Diagrams

- Full convention: `~/dotfiles/docs/diagrams.md`. Follow it in every repo.
- One file per diagram: `docs/diagrams/<name>.drawio.svg` (kebab-case). A `.drawio.svg` is a valid SVG with the draw.io XML source embedded: GitHub renders it, and the VS Code drawio extension (`hediet.vscode-drawio`) edits it. No export step.
- Embed in markdown with `![alt](docs/diagrams/<name>.drawio.svg)`. Never paste raw draw.io XML or Mermaid source fences into markdown.
- Create or edit in VS Code, or via CLI: `drawio -x -f svg -e -o docs/diagrams/<name>.drawio.svg <name>.drawio`. The `-e` flag embeds the source; without it the SVG is not re-editable.
- Fallback when a plain image file is required (e.g. Marp decks): keep the `.drawio`/`.mmd` source next to the rendered image and export with the `drawio` CLI (see the `export-drawio-diagrams-as-images-via-cli` skill).
- Check the rendered diagram in GitHub light and dark mode before merging.

## Browser Automation

- Default tool: playwriter CLI (`playwriter -s <session> -e '<playwright JS>'`). It drives the real Brave browser through an extension bridge, so logged-in sessions work and bot detection sees a real browser. Full reference: `~/.pi/agent/skills/playwriter/SKILL.md` (context-mode source `playwriter-skill`); setup doc: `docs/browser-automation.md` in the dotfiles repo.
- Two supported surfaces, never the daily stable Brave (it deliberately has no extension): the **default Brave Beta profile** (Web Store extension, Luis's primary interactive use) and the **Brave Beta automation profile** (`~/.pi/agent/data/playwright-brave-beta`, unpacked extension via `--load-extension`, the surface for agent and clean-room work). When only the default-profile Beta is running, a plain `playwriter session new` binds to it; prefer the automation profile for tasks that must not share the daily browser's cookies or tabs.
- Two Beta instances can run side by side (each `--user-data-dir` is its own instance). Dock focus can land on the wrong one. Identify instances by pid: `ps aux | grep "MacOS/Brave Browser Beta" | grep -v Helper`.
- Consent model: agent-created tabs (`context.newPage()`) work directly. Pre-existing tabs need one manual extension-icon click each.
- Use Playwright MCP for clean-room tasks where no login state should exist.
- Read-only scraping of bot-protected sites: cookie replay via curl stays the fallback (skill `scrape-logged-in-site-via-browser-cookie-replay`).
- Keep the playwriter MCP entry in proxy mode (directTools:false). Its `execute` tool description is 53KB and would bloat the standing prompt. Use the CLI.

