# Global Preferences

> Canonical global preferences, shared by pi (`~/.pi/agent/AGENTS.md`) and Claude Code (`~/.claude/CLAUDE.md`, a symlink to this file). Edit here only.

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
- After approval, switch to execution. Do not re-ask what the plan already settled.

### Execution

- Default to acting over asking: make the reasonable call and proceed on judgment calls you're equipped to make.
- Ask only when genuinely blocked: a decision only the user can make, input that can't be inferred, or an action that's destructive, hard to reverse, or visible to others (force-push, `rm -rf`, sending messages, posting publicly, etc.).
- Don't ask "should I proceed?" or "want me to also do X?" when the answer is inferable from the request. Do it and report what changed.
- Stay in scope. Judgment calls that serve the request are yours to make. Changes beyond the request belong in `Next steps`, not in the diff.
- Standing rules elsewhere in this file still apply. The Commits gate, the GitHub issue gate, and the Scratch Files triggers are not judgment calls.

## Writing Style

- Always use simple language, in chat replies and in files. Prefer common words: "use" not "utilize", "show" not "demonstrate", "start" not "initiate", "need" not "require".
- Follow ASD-STE100 (Simplified Technical English), lighter variant: short sentences (aim for 20 words or fewer), one idea per sentence, active voice, no filler or hedging.
- No hyphens (`-`) or em dashes (`—`) as punctuation in prose. Rewrite with commas, periods, parentheses, or colons instead. Hyphens are still fine in compound words (e.g. `well-formatted`), command flags (e.g. `--no-verify`), and markdown list markers.
- Scope: chat replies, scratch files, docs, READMEs, tickets, commit messages. Code, identifiers, commands, and quoted text are exempt.
- Do not hard-wrap prose in markdown files at a fixed column (no 80-char limit). Write flowing long lines: one bullet per line, one sentence or logical unit per line.
- Always link to PRs and online resources. When you mention a PR, Jira ticket, Slack thread, doc, or any resource with a URL, include the full clickable URL (e.g. https://github.com/hellofresh/schema-registry/pull/4222), not just `schema-registry#4222` or `GLOA-338`.

## Reporting Back

- Start substantial replies with a `TLDR:` line at the top. One or two short sentences: the outcome, the answer, or what changed. Details go below.
- End substantial replies with a `Next steps:` section: a short bullet list of open decisions, suggested follow-ups, and extras I noticed but did not do.
- Add both when the reply reports completed work, research findings, or a plan. Skip both for short answers, questions back to me, and quick confirmations.

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
- GitHub issue gate: discuss the plan or spec in chat first. Run `gh issue create` only after the user approves or explicitly asks. Until then the chat reply is the draft, and `gh issue create` is never a judgment call.
- Reserve in-repo markdown for code-adjacent docs (READMEs, setup notes). Plans, roadmaps, and trackers belong in issues.
- If the team uses a different tracker, use that instead. HelloFresh repos use Jira: see `~/projects/hellofresh/AGENTS.md`.

## Commits

- Do not stage or commit on your own. Leave changes as unstaged modifications in the working tree; the user reviews them with VS Code's "Open Changes" diff view, which works best on uncommitted changes. Run `git add` and `git commit` only after the user approves.
- Commit only the files for the approved change. Review the full working tree first and leave unrelated or parallel edits out.
- After approval, push per repo convention: dotfiles and other personal projects push straight to the repo's default branch, no pull request needed. The default branch can be named `main`, `master`, `live`, or anything else; find it with `git remote show origin` ("HEAD branch"). HelloFresh repos use feature branches and pull requests.
- Standing instructions that explicitly say to commit (e.g. the Pi Skills section) override the review gate for their scope.
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`.
- No `Co-Authored-By` lines.

## Scratch Files

- Only create a scratch file when the user explicitly asks for one. Triggers: the message contains `scratch:` (with the colon, e.g. `scratch: write a summary of ...`), or the user explicitly says "save to scratch" or "write this to a scratch file".
- Default for proofreading, drafts, reviews, and any other text output: reply in chat, no scratch file.
- When asked: write to `~/scratch/<descriptive-name>.md` (e.g. `proofread-team-update.md`), then print the full absolute path so the user can click to open it.
- For follow-up edits, update the same file rather than creating a new one.

## Dotfiles

- Dotfiles live at `~/dotfiles` (a git repo). Read from there directly when relevant; no symlink needed. Treat `~/dotfiles/.env` as real secrets and never surface its values unless asked.
- `claude/.claude/settings.json` is NOT stowed (`.stow-local-ignore`): Claude Code rewrites the live `~/.claude/settings.json` at runtime, which would clobber a symlink. The live file is the source of truth; the dotfiles copy is a snapshot. To change a setting, edit the live file, then refresh the snapshot: `cp ~/.claude/settings.json ~/dotfiles/claude/.claude/settings.json`.
- Same pattern for pi: `pi/.pi/agent/settings.json` and `pi/.pi/agent/mcp-adapter.json` are NOT stowed (`pi/.stow-local-ignore`). pi rewrites both at runtime (changelog version on startup, MCP server installs), which would clobber symlinks. Edit the live file, then refresh the snapshot: `cp ~/.pi/agent/settings.json ~/dotfiles/pi/.pi/agent/settings.json` (same for `mcp-adapter.json`).

## Pi Skills

- Skills live in `~/pi-skills` (a git repo with a GitHub remote), symlinked into `~/.pi/agent/skills` and `~/.pi/agent/pi-hermes-memory/skills`. Not stowed in dotfiles.
- After creating or patching a skill with `skill_manage`, commit and push `~/pi-skills` before ending the session. Conventional commits, direct to `main`.

## Worktrees

- Worktree lifecycle is owned by [worktrunk](https://worktrunk.dev) (`wt`), configured in `~/dotfiles/worktrunk/.config/worktrunk/config.toml`.
- To create or switch a worktree as an agent: `WORKTRUNK_AGENT=1 wt switch --create <branch> --no-cd --yes --format json`
- The env var skips only the VS Code window. All setup hooks still run (venv symlink, copy-ignored, known-repos registry, AGENTS.md links), so the worktree stays a normal registered worktree visible in `cop list` and understory.
- Never use `cop new` (human facing, opens VS Code) or raw `git worktree add` (skips hooks and registry).

## HelloFresh Business Impact

- The Jira ticket is the source of truth, harvest (`~/.harvest/`, CLI `harvest`, repo `~/projects/personal/harvest`) is its database, the PR is a projection. Never write the same impact data in two places.
- Sequence, always ticket first: `harvest create ticket --summary ... -c ... -i ... -n ... -s ... -e ... -w ...` (records the full row in harvest AND creates the Jira ticket with the four-field projection block; dollars and estimate basis live only in harvest, never on Jira); branch `type/<KEY>-short-desc`; draft PR with labels only (NEVER a Business Impact block in the PR body), then `harvest record pr <repo>#<n> --ticket <KEY>` (impact fields inherit from the ticket row).
- Estimate changed: `harvest record ticket <KEY>` with the new flags, then `harvest project <KEY>` if a projected field (Category, Notes, Scope, Work Type) changed; dollar/basis changes never touch Jira. Update PR labels only if category/scope changed.
- Full spec (taxonomy, block format, label colors): `~/projects/hellofresh/AGENTS.md` section "Business Impact". Reports: `harvest report --year <yyyy>`.

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
- Use it ONLY against the Brave Beta automation profile (`~/.pi/agent/data/playwright-brave-beta`). Never drive the daily stable Brave; it deliberately has no extension.
- Consent model: agent-created tabs (`context.newPage()`) work directly. Pre-existing tabs need one manual extension-icon click each.
- Use Playwright MCP for clean-room tasks where no login state should exist.
- Read-only scraping of bot-protected sites: cookie replay via curl stays the fallback (skill `scrape-logged-in-site-via-browser-cookie-replay`).
- Keep the playwriter MCP entry in proxy mode (directTools:false). Its `execute` tool description is 53KB and would bloat the standing prompt. Use the CLI.

