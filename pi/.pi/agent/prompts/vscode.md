---
description: Open this project in VS Code and hand off the current pi session to continue there
argument-hint: "[new]"
---
Open the current project in VS Code and prepare to continue this exact pi session from there.

1. Resolve the project root: `git rev-parse --show-toplevel` if inside a git repo, otherwise the current working directory.
2. Check that the VS Code CLI is available with `command -v code`. If missing, stop and report that `code` isn't on PATH (fix: Cmd+Shift+P → "Shell Command: Install 'code' command in PATH" inside VS Code).
3. Open VS Code on that root:
   - By default, reuse an existing window for that root if one is open: `code "<root>"`.
   - If the first argument is the literal word `new`, force a new window instead: `code -n "<root>"`.
4. Check `$PI_SESSION_FILE` (injected automatically into bash tool commands):
   - If set and the file exists on disk, copy the exact resume command to the clipboard with `pbcopy`: `cd "<root>" && pi --session "$PI_SESSION_FILE"`.
   - If unset (ephemeral session, started with `--no-session`) or the file doesn't exist, skip the clipboard step and note there is no valid session file to resume.
5. Report back concisely: confirm VS Code opened, and if a resume command was copied, tell me to open a terminal in VS Code (Cmd+`) and paste it to continue this session there.

Do not close, exit, or otherwise disrupt this current session. Only use the bash tool for the steps above.
