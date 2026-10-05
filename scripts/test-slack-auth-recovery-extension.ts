// Mock-harness test for the slack-auth-recovery pi extension.
// Drives the real extension file with a stubbed ExtensionAPI: canned
// slack-hf-session --check results, recorded pkill calls, synthetic
// tool_result events, and a mocked Date.now for the time-based guards.
//
// Run: bun scripts/test-slack-auth-recovery-extension.ts

const { default: ext } = await import("../pi/.pi/agent/extensions/slack-auth-recovery.ts")

// --- stub ExtensionAPI / ExtensionContext -----------------------------------
class MockPi {
  handlers: Record<string, Function[]> = {}
  commands: Record<string, Function> = {}
  execCalls: string[][] = []
  probeValid = true
  probeThrows = false
  on(event: string, fn: Function) {
    ;(this.handlers[event] ??= []).push(fn)
  }
  registerCommand(name: string, opts: { handler: Function }) {
    this.commands[name] = opts.handler
  }
  async exec(cmd: string, args: string[]) {
    this.execCalls.push([cmd, ...args])
    if (cmd === "slack-hf-session") {
      if (this.probeThrows) throw new Error("spawn slack-hf-session ENOENT")
      return { stdout: "", stderr: "", code: this.probeValid ? 0 : 1, killed: false }
    }
    if (cmd === "pkill") return { stdout: "", stderr: "", code: 0, killed: false }
    throw new Error("unexpected exec: " + cmd)
  }
  async fireToolResult(event: any) {
    let result
    const ctx = { ui: { notify } }
    for (const fn of this.handlers["tool_result"] ?? []) {
      const r = await fn(event, ctx)
      if (r !== undefined) result = r
    }
    return result
  }
  probeCount(): number {
    return this.execCalls.filter((c) => c[0] === "slack-hf-session").length
  }
  killCount(): number {
    return this.execCalls.filter((c) => c[0] === "pkill").length
  }
}

const notes: string[] = []
const notify = (msg: string, level: string) => notes.push(`${level}:${msg}`)

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}`)
  }
}

// --- time control ------------------------------------------------------------
const realNow = Date.now
let fakeNow = 1_000_000_000
Date.now = () => fakeNow
const advance = (ms: number) => (fakeNow += ms)

// --- event factory -----------------------------------------------------------
function ev(over: any = {}) {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "slack_conversations_history",
    input: { channel_id: "C123" },
    isError: true,
    content: [{ type: "text", text: "Error: failed to fetch history: invalid_auth" }],
    details: { error: "tool_error", server: "slack" },
    ...over,
  }
}
const noteText = (r: any): string => r?.content?.map((b: any) => b.text).join("\n") ?? ""

// --- scenarios (order matters: module state persists) -------------------------
const pi = new MockPi()
await ext(pi as any)

// 1. unrelated tool: ignored
let r = await pi.fireToolResult(ev({ toolName: "bash", details: undefined }))
check("non-slack tool ignored", r === undefined && pi.execCalls.length === 0)

// 2. slack success: ignored
r = await pi.fireToolResult(ev({ isError: false, content: [{ type: "text", text: "3 messages" }], details: { server: "slack" } }))
check("slack success ignored", r === undefined && pi.execCalls.length === 0)

// 3. long successful dump mentioning invalid_auth: ignored (false-positive guard)
r = await pi.fireToolResult(
  ev({ isError: false, content: [{ type: "text", text: `see invalid_auth docs ${"x".repeat(600)}` }], details: { server: "slack" } }),
)
check("long success mentioning invalid_auth ignored", r === undefined && pi.execCalls.length === 0)

// 4. auth failure + valid fresh session: probe + kill + retry note
r = await pi.fireToolResult(ev())
check("auth failure: retry note appended", noteText(r).includes("retry the same call once now"))
check("auth failure: probe ran", pi.probeCount() === 1)
check("auth failure: server killed", pi.killCount() === 1)
check("auth failure: info notify", notes.some((n) => n.startsWith("info:") && n.includes("fresh session found")))

// 5. second auth failure inside the kill grace: grace note, no new probe/kill
advance(5_000)
r = await pi.fireToolResult(ev({ toolCallId: "call-2" }))
check("kill grace: grace note", noteText(r).includes("fresh Slack session was installed"))
check("kill grace: no new probe or kill", pi.probeCount() === 1 && pi.killCount() === 1)

// 6. after grace, probe invalid: sign-in note, no kill; cooldown suppresses re-probe
advance(40_000)
pi.probeValid = false
r = await pi.fireToolResult(ev({ toolCallId: "call-3" }))
check("probe invalid: sign-in note", noteText(r).includes("sign back into Slack.app"))
check("probe invalid: no kill", pi.killCount() === 1)
check("probe invalid: error notify", notes.some((n) => n.startsWith("error:")))
advance(10_000)
r = await pi.fireToolResult(ev({ toolCallId: "call-4" }))
check("failed-probe cooldown: sign-in note without re-probe", noteText(r).includes("sign back into Slack.app") && pi.probeCount() === 2)

// 7. launch failure (server down) + valid probe: backoff note, no kill
advance(60_000)
pi.probeValid = true
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-5",
    isError: false,
    content: [{ type: "text", text: 'MCP server "slack" not available (failed 12s ago: process exited)' }],
    details: { error: "server_unavailable", server: "slack" },
  }),
)
check("launch failure: backoff retry note", noteText(r).includes("wait about 60 seconds"))
check("launch failure: probe ran, no kill", pi.probeCount() === 3 && pi.killCount() === 1)

// 8. mcp gateway path (toolName mcp, input.server slack) with auth error
advance(10_000)
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-6",
    toolName: "mcp",
    input: { server: "slack", tool: "conversations_history", args: {} },
    details: undefined,
  }),
)
check("mcp gateway path: retry note + kill", noteText(r).includes("retry the same call once now") && pi.killCount() === 2)

// 9. kill cap: 3rd kill works, 4th is refused without a probe
advance(40_000)
await pi.fireToolResult(ev({ toolCallId: "call-7" }))
check("third kill allowed", pi.killCount() === 3)
advance(40_000)
const probesBefore = pi.probeCount()
r = await pi.fireToolResult(ev({ toolCallId: "call-8" }))
check("kill cap: refuses without probing", pi.killCount() === 3 && pi.probeCount() === probesBefore && noteText(r).includes("keeps rejecting"))

// 10. short auth-error text without details/isError still counts as a failure
advance(20 * 60_000) // age out the kill window
r = await pi.fireToolResult(ev({ toolCallId: "call-9", isError: false, details: undefined, content: [{ type: "text", text: "invalid_auth" }] }))
check("bare short invalid_auth text handled", pi.killCount() === 4)

// 11. helper missing (exec throws): treated as invalid, warns once
advance(60_000)
pi.probeThrows = true
notes.length = 0
r = await pi.fireToolResult(ev({ toolCallId: "call-10" }))
check("helper missing: sign-in note, no kill", noteText(r).includes("sign back into Slack.app") && pi.killCount() === 4)
check("helper missing: one error notify", notes.filter((n) => n.includes("not executable")).length === 1)

// 12. /slack-reauth command: valid probe kills, invalid probe does not
pi.probeThrows = false
pi.probeValid = true
advance(60_000)
await pi.commands["slack-reauth"]({}, { ui: { notify } })
check("/slack-reauth: kills on valid probe", pi.killCount() === 5)
pi.probeValid = false
const killsBefore = pi.killCount()
await pi.commands["slack-reauth"]({}, { ui: { notify } })
check("/slack-reauth: no kill on invalid probe", pi.killCount() === killsBefore)

// 13. gateway tool-call shape: mcp({tool: "slack_channels_list"}), launch failure as plain text
advance(60_000)
pi.probeValid = true
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-11",
    toolName: "mcp",
    input: { tool: "slack_channels_list", args: { limit: 3 } },
    isError: false,
    content: [{ type: "text", text: 'Server "slack" not available (last failed 0s ago: Connection closed)' }],
    details: undefined,
  }),
)
check("gateway launch failure: backoff note", noteText(r).includes("wait about 60 seconds"))
check("gateway launch failure: no kill", pi.killCount() === 5)

// 14. gateway connect shape: mcp({connect: "slack"})
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-12",
    toolName: "mcp",
    input: { connect: "slack" },
    isError: false,
    content: [{ type: "text", text: 'Failed to connect to "slack": Connection closed' }],
    details: undefined,
  }),
)
check("gateway connect failure: backoff note", noteText(r).includes("wait about 60 seconds"))

// 15. gateway auth failure forwarded as text (isError false): kill + retry note
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-13",
    toolName: "mcp",
    input: { tool: "slack_conversations_history", args: {} },
    isError: false,
    content: [{ type: "text", text: "Error: failed to call tool: invalid_auth" }],
    details: undefined,
  }),
)
check("gateway auth failure: kill + retry note", noteText(r).includes("retry the same call once now") && pi.killCount() === 6)

// 16. gateway success mentioning slack: ignored
advance(40_000)
const execsBefore = pi.execCalls.length
r = await pi.fireToolResult(
  ev({
    toolCallId: "call-14",
    toolName: "mcp",
    input: { server: "slack" },
    isError: false,
    content: [{ type: "text", text: 'Server "slack": connected, 4 tools' }],
    details: undefined,
  }),
)
check("gateway success ignored", r === undefined && pi.execCalls.length === execsBefore)

// 17. invalid probe long after the last valid one: plain sign-in note (not hot)
advance(16 * 60_000)
pi.probeValid = false
r = await pi.fireToolResult(ev({ toolCallId: "call-15" }))
check("cold sign-out: plain note", noteText(r).includes("sign back into Slack.app") && !noteText(r).includes("15 minutes"))

// 18. valid probe then invalid probe within the hot window: cool-off note
advance(60_000)
pi.probeValid = true
r = await pi.fireToolResult(ev({ toolCallId: "call-16" }))
check("valid probe again: kill + retry note", noteText(r).includes("retry the same call once now") && pi.killCount() === 7)
advance(40_000)
pi.probeValid = false
r = await pi.fireToolResult(ev({ toolCallId: "call-17" }))
check("hot detector: cool-off note", noteText(r).includes("15 minutes"))

Date.now = realNow
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
