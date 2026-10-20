// Run `!!!` bang commands in the user's interactive zsh instead of bash.
//
// Pi's `!` passthrough runs /bin/bash -c, which loads no rc files, so shell
// functions and aliases from the zsh config (e.g. gurl in funcs_git.zsh) fail
// with "command not found". `!!!<cmd>` fixes that: the TUI parses the leading
// bangs first (`!!!gurl` -> `!!` exclude-from-context + command `!gurl`), then
// this extension's user_bash handler sees the marker bang, strips it, and
// returns BashOperations that run the rest in `zsh -ic`. Pi's own streaming,
// cancellation (Esc), truncation, and session recording all stay intact: only
// the shell differs.
//
// Because the marker rides the `!!` prefix, `!!!` commands are always excluded
// from the model's context. There is no in-context variant; pi's bang parsing
// collapses any single-bang + marker combination into `!!`.
//
// Handler order: this extension must load after the split extension
// (`split/index.ts`, its user_bash handler tracks command starts and returns
// undefined). Extensions load in directory order, and "z" sorts after
// "split", so no ordering config is needed.

import { spawn } from "node:child_process"
import { constants as osConstants } from "node:os"

import type {
  BashOperations,
  ExtensionAPI,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent"

const ZSH = "/bin/zsh"

// znap's cached fzf eval calls bindkey, which prints this on stderr when zle
// cannot start (stdin is not a tty under pi). Drop only these exact lines.
const ZLE_NOISE = /^\(eval\):\d+: can't change option: zle$/

function zshOperations(): BashOperations {
  return {
    exec: async (rawCommand, cwd, { onData, signal, timeout, env }) => {
      // Strip the marker bang the handler matched on.
      const command = rawCommand.replace(/^!\s*/, "")
      if (!command) {
        onData(Buffer.from("zsh-bang: no command after !!!\n"))
        return { exitCode: 0 }
      }
      if (signal?.aborted) throw new Error("aborted")

      // Detached so abort can kill the whole process group (pi's own shell
      // operations do the same); -ic loads the full interactive zsh config.
      const child = spawn(ZSH, ["-ic", command], {
        cwd,
        detached: process.platform !== "win32",
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })

      const killGroup = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM")
          } catch {
            // Process group already gone.
          }
        }
      }
      const onAbort = () => killGroup()
      signal?.addEventListener("abort", onAbort, { once: true })

      let timedOut = false
      const timeoutMs = timeout !== undefined ? timeout * 1000 : undefined
      const timeoutHandle =
        timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true
              killGroup()
            }, timeoutMs)
          : undefined

      // Idle grace after zsh exits: a background descendant that inherited the
      // pipes (`!!!long-job &`) keeps them open forever, so 'close' would never
      // fire. After zsh exits, wait for the pipes to go quiet for GRACE_MS,
      // re-armed on every chunk so an actively writing descendant keeps us
      // reading, then destroy the streams so 'close' fires. Mirrors pi's own
      // waitForChildProcess (earendil-works/pi#5303).
      const GRACE_MS = 3000
      let lastActivity = Date.now()
      let graceHandle: ReturnType<typeof setTimeout> | undefined
      const noteActivity = () => {
        lastActivity = Date.now()
      }
      const clearGrace = () => {
        if (graceHandle) clearTimeout(graceHandle)
        graceHandle = undefined
      }
      const armGrace = () => {
        clearGrace()
        lastActivity = Date.now()
        const tick = () => {
          if (Date.now() - lastActivity >= GRACE_MS) {
            child.stdout?.destroy()
            child.stderr?.destroy()
            return
          }
          graceHandle = setTimeout(tick, GRACE_MS - (Date.now() - lastActivity))
        }
        graceHandle = setTimeout(tick, GRACE_MS)
      }
      child.stdout?.on("data", noteActivity)
      child.stderr?.on("data", noteActivity)
      child.on("exit", armGrace)

      // stdout streams straight through; stderr is line-filtered so the zle
      // noise lines above are dropped without touching real error output.
      child.stdout?.on("data", onData)
      let stderrRest = ""
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrRest += chunk.toString()
        let nl: number
        while ((nl = stderrRest.indexOf("\n")) !== -1) {
          const line = stderrRest.slice(0, nl + 1)
          stderrRest = stderrRest.slice(nl + 1)
          if (!ZLE_NOISE.test(line.trimEnd())) onData(Buffer.from(line))
        }
      })

      // Wait for exit like pi does: 'close' fires only after the pipes drain,
      // so output from a background descendant is not cut off at exit.
      //
      // Cleanup is in the finally block so a spawn error (reject) cannot leak
      // the abort listener or the pending timers.
      let exitCode: number | null
      try {
        exitCode = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject)
          child.on("close", (code, signalCode) => {
            clearGrace()
            if (stderrRest && !ZLE_NOISE.test(stderrRest.trimEnd())) {
              onData(Buffer.from(stderrRest))
            }
            // Signal-killed shell has no exit code; use the shell convention so
            // callers do not mistake the kill for a successful command.
            resolve(signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : code)
          })
        })
      } finally {
        clearGrace()
        if (timeoutHandle) clearTimeout(timeoutHandle)
        signal?.removeEventListener("abort", onAbort)
      }
      if (signal?.aborted) throw new Error("aborted")
      if (timedOut) throw new Error(`timeout:${timeout}`)
      return { exitCode: exitCode ?? 1 }
    },
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("user_bash", (event: UserBashEvent): UserBashEventResult | undefined => {
    // `!!!cmd` arrives here (after the TUI stripped `!!`) as `!cmd`. A leading
    // bang is the zsh marker; bash itself has no useful command starting with
    // one, so no passthrough case needs to survive.
    if (!event.command.startsWith("!")) return undefined
    return { operations: zshOperations() }
  })
}
