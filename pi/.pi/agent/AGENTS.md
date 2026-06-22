# Global Preferences

## Python

- Always use `uv` for Python operations (`uv run` instead of `python`, `uv pip` instead of `pip`, `uv venv` instead of `python -m venv`, etc.)

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)

## Commits

- Complete all file changes before staging or committing — let the user review first
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines

## Scratch Files

- When asked to proofread or produce any text output for review, write results to `~/.pi/scratch/<descriptive-name>.md`
- After writing a scratch file, print its full absolute path so the user can click to open it
- For follow-up edits, update the same file rather than creating a new one
- Use descriptive filenames (e.g. `proofread-team-update.md`)

## Writing Style

- Do not use hyphens (`-`) or em dashes (`—`) as punctuation in prose. Rewrite sentences using commas, periods, parentheses, or colons instead
- This applies to written output (responses, scratch files, commit messages, tickets, docs). Hyphens are still fine in compound words (e.g. `well-formatted`), command flags (e.g. `--no-verify`), and markdown list markers
