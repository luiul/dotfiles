# Global Preferences

> Canonical global preferences, shared by pi (`~/.pi/agent/AGENTS.md`) and Claude Code (`~/.claude/CLAUDE.md`, a symlink to this file). Edit here only.

## Autonomy

- Default to acting over asking: make the reasonable call and proceed on judgment calls you're equipped to make.
- Ask only when genuinely blocked: a decision only the user can make, input that can't be inferred, or an action that's destructive, hard to reverse, or visible to others (force-push, `rm -rf`, sending messages, posting publicly, etc.).
- Don't ask "should I proceed?" or "want me to also do X?" when the answer is inferable from the request. Do it and report what changed.

## Writing Style

- Always use simple language, in chat replies and in files. Prefer common words: "use" not "utilize", "show" not "demonstrate", "start" not "initiate", "need" not "require".
- Follow ASD-STE100 (Simplified Technical English), lighter variant: short sentences (aim for 20 words or fewer), one idea per sentence, active voice, no filler or hedging.
- No hyphens (`-`) or em dashes (`—`) as punctuation in prose. Rewrite with commas, periods, parentheses, or colons instead. Hyphens are still fine in compound words (e.g. `well-formatted`), command flags (e.g. `--no-verify`), and markdown list markers.
- Scope: chat replies, scratch files, docs, READMEs, tickets, commit messages. Code, identifiers, commands, and quoted text are exempt.

## Python

- Always use `uv` for Python operations: `uv run` not `python`, `uv pip` not `pip`, `uv venv` not `python -m venv`, etc.

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)
- The `gh` account `luiul` is intentional for both work and personal repos; do not flag it as a misconfiguration.

## Planning & Tracking

- Track bigger projects, multi-step plans, and design docs as GitHub issues (`gh issue create`; update via `gh issue comment` or body edits), not markdown files committed to the repo root.
- Reserve in-repo markdown for code-adjacent docs (READMEs, setup notes). Plans, roadmaps, and trackers belong in issues.
- If GitHub Issues is disabled, use that platform's tracker instead (HelloFresh repos use Jira; see the HelloFresh context).

## Commits

- Complete all file changes before staging or committing; let the user review first.
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`.
- No `Co-Authored-By` lines.

## Scratch Files

- Write proofreading and text output for review to `~/scratch/<descriptive-name>.md` (e.g. `proofread-team-update.md`), then print the full absolute path so the user can click to open it.
- For follow-up edits, update the same file rather than creating a new one.

## Dotfiles

- Dotfiles live at `~/dotfiles` (a git repo). Read from there directly when relevant; no symlink needed. Treat `~/dotfiles/.env` as real secrets and never surface its values unless asked.
- `claude/.claude/settings.json` is NOT stowed (`.stow-local-ignore`): Claude Code rewrites the live `~/.claude/settings.json` at runtime, which would clobber a symlink. The live file is the source of truth; the dotfiles copy is a snapshot. To change a setting, edit the live file, then refresh the snapshot: `cp ~/.claude/settings.json ~/dotfiles/claude/.claude/settings.json`.

## Pi Skills

- Skills live in `~/pi-skills` (a git repo with a GitHub remote), symlinked into `~/.pi/agent/skills` and `~/.pi/agent/pi-hermes-memory/skills`. Not stowed in dotfiles.
- After creating or patching a skill with `skill_manage`, commit and push `~/pi-skills` before ending the session. Conventional commits, direct to `main`.

## Large Files

- Read files over 2,000 lines in chunks via the read tool's `offset` and `limit` parameters, not all at once.

## Diagrams

- Full convention: `~/dotfiles/docs/diagrams.md`. Follow it in every repo.
- One file per diagram: `docs/diagrams/<name>.drawio.svg` (kebab-case). A `.drawio.svg` is a valid SVG with the draw.io XML source embedded: GitHub renders it, and the VS Code drawio extension (`hediet.vscode-drawio`) edits it. No export step.
- Embed in markdown with `![alt](docs/diagrams/<name>.drawio.svg)`. Never paste raw draw.io XML or Mermaid source fences into markdown.
- Create or edit in VS Code, or via CLI: `drawio -x -f svg -e -o docs/diagrams/<name>.drawio.svg <name>.drawio`. The `-e` flag embeds the source; without it the SVG is not re-editable.
- Fallback when a plain image file is required (e.g. Marp decks): keep the `.drawio`/`.mmd` source next to the rendered image and export with the `drawio` CLI (see the `export-drawio-diagrams-as-images-via-cli` skill).
- Check the rendered diagram in GitHub light and dark mode before merging.

