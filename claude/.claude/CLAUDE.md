# 1. Global Preferences

## 1.1. Python

- Always use `uv` for Python operations (`uv run` instead of `python`, `uv pip` instead of `pip`, `uv venv` instead of `python -m venv`, etc.)

## 1.2. GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)

## 1.3. Commits

- Complete all file changes before staging or committing — let the user review first
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines

## 1.4. Scratch Files

- When asked to proofread, draft Jira tickets, or produce any text output for review, write results to `~/.claude/scratch/<descriptive-name>.md`
- After writing a scratch file, print its full absolute path so the user can click to open it
- For follow-up edits, update the same file rather than creating a new one
- Use descriptive filenames (e.g. `proofread-team-update.md`, `jira-auth-migration.md`)

## 1.5. Jira Tickets

- Project key: `ISA` (INT SCM Analytics)
- Board: Global Ops DE Scrum (board ID 11974)
- Use the `mcp-atlassian` MCP tools for all Jira interactions
- Required fields when creating issues:
  - `project_key`: `ISA`
  - `issue_type`: usually `Task`
  - `components`: `Data Integration`
  - `additional_fields`: must include `fixVersions: [{"id": "30557"}]` (Engineering) — the board filters on this, tickets won't appear without it
  - `labels`: `["dbt", "xps"]` for data engineering work
- Assignee: `luis.aceituno@hellofresh.com`
- Always draft tickets in a scratch file first, let the user review, then create in Jira
