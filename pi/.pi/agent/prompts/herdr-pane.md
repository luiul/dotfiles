---
description: Ensure a herdr workspace/pane exists for this directory (idempotent), before running pi somewhere herdr can't see (e.g. VS Code's own integrated terminal)
argument-hint: "[label]"
---
Ensure a herdr workspace/pane is registered for the current directory, so that pi
run here later (even outside a herdr-managed terminal, like VS Code's built-in
one) gets picked up by `herdr-agent-state-external.ts` via a plain lookup instead
of falling through to that extension's own auto-create fallback. Running this
ahead of time avoids ever hitting that fallback's create path at all, including
its cross-process race window when two terminals are opened for the same
directory at nearly the same moment.

1. Resolve the target directory: `git rev-parse --show-toplevel` if inside a git
   repo, otherwise the current working directory.
2. Check `herdr` is on PATH (`command -v herdr`) and the server is reachable
   (`herdr status`). If either fails, stop and report that herdr isn't
   available, don't attempt anything further.
3. Run `herdr api snapshot` and look for a pane whose `cwd` is either exactly
   the resolved directory or an ancestor of it (matching on the longest
   ancestor if more than one qualifies, same rule the extension uses). If
   found, report the existing `pane_id`/`workspace_id` and stop, do not create
   a duplicate.
4. If none found, create one: `herdr workspace create --cwd "<dir>" --label
   "${1:-<basename of dir>}" --no-focus`. Parse the JSON response for
   `result.root_pane.pane_id` and `result.workspace.workspace_id`.
5. Report back concisely: the resolved directory, the pane_id/workspace_id
   (whether found or just created), and a one-line reminder that pi started in
   any terminal at that exact directory will now be auto-detected and shown in
   herdr's sidebar.

Only use the bash tool for the steps above. Do not close, exit, or otherwise
disrupt the current session.
