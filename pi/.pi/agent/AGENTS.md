# Global Preferences

> Canonical global preferences, shared by pi (`~/.pi/agent/AGENTS.md`) and Claude Code (`~/.claude/CLAUDE.md`, a symlink to this file). Edit here only.

## Autonomy

- Default to acting rather than asking. Make the reasonable call and proceed instead of pausing to check in on judgment calls you're equipped to make.
- Only stop to ask when genuinely blocked: a decision only the user can make, missing input that can't be inferred, or an action that's destructive, hard to reverse, or visible to others (force-push, `rm -rf`, sending messages, posting publicly, etc.).
- Don't ask "should I proceed?" or "want me to also do X?" when the answer is inferable from the request. Do it and report what changed.

## Python

- Always use `uv` for Python operations (`uv run` instead of `python`, `uv pip` instead of `pip`, `uv venv` instead of `python -m venv`, etc.)

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)
- The `gh` account `luiul` is used intentionally for both work and personal repos. Do not flag it as a misconfiguration.

## Planning & Tracking

- Track bigger projects, multi-step plans, and design docs as GitHub issues (`gh issue create`; update with `gh issue comment` or by editing the body), not as markdown files committed to the repo root. Keep the repo root clean.
- Reserve in-repo markdown for code-adjacent docs (READMEs, setup notes). Anything that reads like a project plan, roadmap, or tracker belongs in an issue.
- Exception: repos without GitHub Issues enabled. Use that platform's tracker instead (e.g. HelloFresh repos track plans in Jira, see the HelloFresh context).

## Commits

- Complete all file changes before staging or committing — let the user review first
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines

## Scratch Files

- When asked to proofread or produce any text output for review, write results to `~/scratch/<descriptive-name>.md`
- After writing a scratch file, print its full absolute path so the user can click to open it
- For follow-up edits, update the same file rather than creating a new one
- Use descriptive filenames (e.g. `proofread-team-update.md`)

## Dotfiles

- Dotfiles live at `~/dotfiles` (a git repo). Read from there directly when relevant; no symlink needed. Treat `~/dotfiles/.env` as containing real secrets and do not surface its values unless asked.

## Large Files

- When reading files over 2,000 lines, use the `offset` and `limit` parameters on the read tool to read in chunks rather than attempting to read the entire file at once

## Writing Style

- Do not use hyphens (`-`) or em dashes (`—`) as punctuation in prose. Rewrite sentences using commas, periods, parentheses, or colons instead
- This applies to written output (responses, scratch files, commit messages, tickets, docs). Hyphens are still fine in compound words (e.g. `well-formatted`), command flags (e.g. `--no-verify`), and markdown list markers
