// Open the session's working directory in VS Code: super+e.
//
// Uses ctx.cwd, NOT the git repo root. Pi sessions are often started inside a
// subdirectory on purpose: in the HelloFresh global-ops and tardis monorepos
// the dbt projects live in deep subdirs (e.g. databricks/dab/main/dbt/<project>),
// and starting pi there scopes the dbt skills, dbt MCP server, and relative
// paths to the dbt project. The shortcut must open that same scope in VS Code,
// not jump back to the monorepo root.
//
// The binding lives here, not in keybindings.json: keybindings.json only maps
// built-in action ids, and registerShortcut also surfaces the shortcut in
// /hotkeys. super+e is free in pi defaults, in ghostty, and among the existing
// custom bindings (only super+c for app.message.copy is taken; super needs
// the Kitty keyboard protocol, which ghostty provides).
//
// `code <dir>` is spawned detached with stdio ignored, so pi never waits; if
// VS Code already has the folder open it just focuses that window.

import { spawn } from "node:child_process"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("super+e", {
    description: "Open cwd in VS Code",
    handler: (ctx: ExtensionContext) => {
      const proc = spawn("code", [ctx.cwd], {
        cwd: ctx.cwd,
        detached: true,
        stdio: "ignore",
      })
      // Async ENOENT (no code CLI on PATH) must surface, not vanish silently.
      proc.on("error", (err) => {
        ctx.ui.notify(`Cannot open VS Code: ${err.message}`, "error")
      })
      proc.unref()
    },
  })
}
