---
description: Open this project in VS Code and hand off the current pi session to continue there
argument-hint: "[reuse]"
---
Open the current project in VS Code and prepare to continue this exact pi session from there.

1. Resolve the project root: `git rev-parse --show-toplevel` if inside a git repo, otherwise the current working directory.
2. Open VS Code on that root. Default to a new window: `code -n "<root>"`. If the argument is `reuse` (`$1`), use `code "<root>"` instead to reuse an existing window.
3. Check `$PI_SESSION_FILE` (injected automatically into bash tool commands):
   - If set, copy the exact resume command to the clipboard with `pbcopy`: `pi --session "$PI_SESSION_FILE"`.
   - If unset (ephemeral session, started with `--no-session`), skip the clipboard step and note there is no session file to resume.
4. Report back concisely: confirm VS Code opened, and if a resume command was copied, tell me to open a terminal in VS Code (Cmd+`) and paste it to continue this session there.

Do not close, exit, or otherwise disrupt this current session. Only use the bash tool for the steps above.
