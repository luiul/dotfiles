// RTK Pi extension — rewrites bash commands to use rtk for token savings.
// Shared with Oh My Pi (OMP) — OMP loads this same file via its legacy-pi-compat layer.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found → mutate command
//   1           No RTK equivalent → pass through unchanged
//   2 + stderr  RTK denied the rewrite → pass through, warn once
//   3 + stdout  Rewrite (advisory) → mutate command
//
// LOCAL ADDITIONS on top of the rtk-shipped file (ideas from pi-rtk-optimizer,
// re-apply after any `rtk init -g --agent pi` sync; see extensions/README.md):
//   1. Env-prefix-aware rtk detection: `FOO=1 rtk ls` is not re-probed.
//   2. Availability caching: a missing rtk pauses probing for 30s at a time
//      instead of paying a dead exec per bash call, and the extension
//      self-heals when rtk comes back (no pi restart needed).
//   3. Exit code 2 (rtk denied) surfaces a one-time console warning.
//   4. Tail-risk cap on bash output. rtk already compacts rewritten commands
//      (avg 150 output tokens over 3.7k commands), but a single blow-up can
//      still flood the context (observed: 46k tokens from one `rtk grep`).
//      Results over BASH_OUTPUT_MAX_CHARS keep head + tail with a marker.
//      Fires a handful of times per month; pi's own 50KB cap stays the
//      outer bound. Deliberately not a full compaction pipeline: read/grep
//      results and sub-40k outputs stay exact.

import type {
  BashToolCallEvent,
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000
const REPROBE_INTERVAL_MS = 30_000
const MIN_SUPPORTED_RTK_MINOR = 23

// Bash output cap: only fires on tail-risk blow-ups (see header note 4).
const BASH_OUTPUT_MAX_CHARS = 40_000
const BASH_OUTPUT_HEAD_CHARS = 24_000
const BASH_OUTPUT_TAIL_CHARS = 12_000

// Local reimplementation of the package's `isToolCallEventType("bash", event)` type
// guard. That helper is a value export, so importing it pulls in the whole
// `@earendil-works/pi-coding-agent` barrel at extension load — profiled at ~250ms
// warmed, vs ~10ms for a type-only import. `BashToolCallEvent`/`ToolCallEvent`
// below are type-only imports and are erased at compile time, so they carry none
// of that cost. See #2753.
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash"
}

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

// Matches one leading shell env assignment: KEY=value (bare, "double", or
// 'single' quoted) followed by whitespace.
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/

// True when the command already invokes rtk, including after leading env
// assignments (`FOO=1 rtk ls`). Idea from pi-rtk-optimizer, kept minimal.
function isAlreadyRtk(cmd: string): boolean {
  let rest = cmd.trimStart()
  let match: RegExpMatchArray | null
  while ((match = rest.match(ENV_ASSIGNMENT_PATTERN)) !== null) {
    rest = rest.slice(match[0].length).trimStart()
  }
  return rest === "rtk" || rest.startsWith("rtk ")
}

type RewriteOutcome =
  | { kind: "rewrite"; command: string }
  | { kind: "passthrough" }
  | { kind: "denied"; detail: string }
  | { kind: "unavailable" }

// Calls `rtk rewrite`. Never throws: a spawn failure maps to "unavailable" so
// the caller can cache that state.
async function probeRewrite(
  pi: ExtensionAPI,
  cmd: string,
  signal?: AbortSignal
): Promise<RewriteOutcome> {
  let result
  try {
    result = await pi.exec("rtk", ["rewrite", cmd], {
      timeout: REWRITE_TIMEOUT_MS,
      signal,
    })
  } catch {
    return { kind: "unavailable" } // spawn failure (ENOENT etc.)
  }
  if (result.killed) return { kind: "passthrough" } // slow rtk, not dead rtk
  if (result.code === 0 || result.code === 3) {
    const rewritten = result.stdout.trim()
    return rewritten ? { kind: "rewrite", command: rewritten } : { kind: "passthrough" }
  }
  if (result.code === 2) {
    return { kind: "denied", detail: result.stderr.trim() || "rtk denied rewrite" }
  }
  return { kind: "passthrough" } // exit 1 or anything unexpected
}

type VersionProbe =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "too-old"; version: string }

// Probes `rtk --version`. Never throws.
async function probeVersion(pi: ExtensionAPI): Promise<VersionProbe> {
  let ver
  try {
    ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  } catch {
    return { kind: "missing" }
  }
  if (ver.killed || ver.code !== 0) return { kind: "missing" }

  const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))
  if (parsed) {
    const [major, minor] = parsed
    if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
      return { kind: "too-old", version: parsed.join(".") }
    }
  }
  return { kind: "ok" }
}

type StatusContext = {
  ui?: {
    setStatus?: (key: string, text: string) => void
  }
}

// Reports and clears the "RTK disabled" status in the TUI. Register before the
// async version probe so a host cannot miss the handler while the probe is in
// flight. If session_start happens first, retain its context and apply the
// status as soon as a reason is reported (or cleared).
// pi.notify is intentionally not used — OMP wipes it on the initial render.
function registerRtkStatusNotice(pi: ExtensionAPI) {
  let reason: string | undefined
  let sessionContext: StatusContext | undefined

  const applyStatus = () => {
    if (!sessionContext) return
    try {
      sessionContext.ui?.setStatus?.("rtk", reason ? `RTK disabled: ${reason}` : "")
    } catch {
      // Status reporting must never affect the extension's fail-open behavior.
    }
  }

  try {
    pi.on("session_start", (_event: unknown, ctx: unknown) => {
      sessionContext = ctx as StatusContext
      applyStatus()
    })
  } catch {
    // Runtimes without a session_start event: nothing to report.
    return { report: (_reason: string) => {}, clear: () => {} }
  }

  return {
    report: (nextReason: string) => {
      reason = nextReason
      applyStatus()
    },
    clear: () => {
      reason = undefined
      applyStatus()
    },
  }
}

export default async function (pi: ExtensionAPI) {
  const status = registerRtkStatusNotice(pi)

  // Load-time probe. A missing rtk no longer disables the extension: it starts
  // in the unavailable state and self-heals via the handler's 30s re-probe.
  // A too-old rtk still disables it (no `rtk rewrite` subcommand to call).
  let unavailable = false
  let lastProbeAt = 0
  let deniedWarned = false

  const initialProbe = await probeVersion(pi)
  if (initialProbe.kind === "too-old") {
    console.warn(`[rtk] rtk ${initialProbe.version} is too old (need >= 0.23.0) — extension disabled`)
    status.report(`rtk ${initialProbe.version} is too old (need >= 0.23.0)`)
    return
  }
  if (initialProbe.kind === "missing") {
    unavailable = true
    lastProbeAt = Date.now()
    console.warn("[rtk] rtk binary not found in PATH — rewrites paused, re-probing every 30s")
    status.report("rtk binary not found in PATH")
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isBashToolCallEvent(event)) return

      const cmd = event.input.command
      if (typeof cmd !== "string" || cmd.trim() === "") return

      if (isAlreadyRtk(cmd)) return
      if (process.env.RTK_DISABLED === "1") return

      // While rtk is unavailable, skip the dead per-command exec and re-probe
      // at most every REPROBE_INTERVAL_MS until it recovers.
      if (unavailable) {
        const now = Date.now()
        if (now - lastProbeAt < REPROBE_INTERVAL_MS) return
        lastProbeAt = now
        const probe = await probeVersion(pi)
        if (probe.kind !== "ok") return
        unavailable = false
        status.clear()
        console.warn("[rtk] rtk is available again — rewrites resumed")
      }

      const outcome = await probeRewrite(pi, cmd, ctx.signal)
      switch (outcome.kind) {
        case "rewrite":
          if (outcome.command !== cmd) {
            event.input.command = outcome.command
          }
          return
        case "denied":
          if (!deniedWarned) {
            deniedWarned = true
            console.warn(`[rtk] rtk denied a rewrite (${outcome.detail}); passing through`)
          }
          return
        case "unavailable":
          unavailable = true
          lastProbeAt = Date.now()
          status.report("rtk binary not found in PATH")
          return
        default:
          return
      }
    } catch (err) {
      // Fail open: never block execution on an unexpected error.
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", err)
      return
    }
  })

  pi.on("tool_result", async (event) => {
    try {
      if (event.toolName !== "bash") return {}
      const content = event.content
      if (!Array.isArray(content)) return {}

      let changed = false
      const next = content.map((block) => {
        if (block?.type !== "text" || typeof block.text !== "string") return block
        if (block.text.length <= BASH_OUTPUT_MAX_CHARS) return block

        const omitted = block.text.length - BASH_OUTPUT_HEAD_CHARS - BASH_OUTPUT_TAIL_CHARS
        const head = block.text.slice(0, BASH_OUTPUT_HEAD_CHARS)
        const tail = block.text.slice(-BASH_OUTPUT_TAIL_CHARS)
        changed = true
        return {
          ...block,
          text:
            head +
            `\n\n[rtk: omitted ${omitted} chars from the middle of a ${block.text.length}-char bash output; ` +
            `re-run a narrower command if you need them]\n\n` +
            tail,
        }
      })

      return changed ? { content: next } : {}
    } catch (err) {
      // Fail open: never block or alter output on an unexpected error.
      console.warn("[rtk] unexpected error in tool_result handler; passing through output", err)
      return {}
    }
  })
}
