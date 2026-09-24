// Mock-harness test for the rtk pi extension.
// Drives the real extension file with a stubbed ExtensionAPI and canned
// `rtk` exec results, asserting command mutation and probe caching behavior.
import ext from "../pi/.pi/agent/extensions/rtk.ts"

type ExecResult = { code: number; stdout: string; stderr: string; killed: boolean }

class MockPi {
  handlers: Record<string, Function[]> = {}
  execCalls: string[][] = []
  execImpl: (cmd: string, args: string[]) => ExecResult = () => ({ code: 1, stdout: "", stderr: "", killed: false })
  on(event: string, fn: Function) {
    ;(this.handlers[event] ??= []).push(fn)
  }
  async exec(cmd: string, args: string[], _opts?: unknown): Promise<ExecResult> {
    this.execCalls.push([cmd, ...args])
    return this.execImpl(cmd, args)
  }
  async fireToolCall(command: string) {
    const event = { toolName: "bash", input: { command } }
    for (const fn of this.handlers["tool_call"] ?? []) await fn(event, { signal: undefined })
    return event.input.command
  }
  rewriteExecCount() {
    return this.execCalls.filter((c) => c[1] === "rewrite").length
  }
}

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}`)
  }
}

const OK_VERSION: ExecResult = { code: 0, stdout: "rtk 0.50.0", stderr: "", killed: false }
const realDateNow = Date.now
let fakeNow = realDateNow()

function silenceWarns() {
  const orig = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
  return { warnings, restore: () => (console.warn = orig) }
}

// --- Scenario 1: happy path, rewrites and passthroughs ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = (_cmd, args) => {
    if (args[0] === "--version") return OK_VERSION
    if (args[1] === "git status") return { code: 0, stdout: "rtk git status\n", stderr: "", killed: false }
    return { code: 1, stdout: "", stderr: "", killed: false }
  }
  await ext(pi as any)
  check("s1: git status rewritten", (await pi.fireToolCall("git status")) === "rtk git status")
  check("s1: unknown command unchanged", (await pi.fireToolCall("make foo")) === "make foo")
  check("s1: non-bash tool ignored", await (async () => {
    const ev = { toolName: "read", input: { command: "git status" } }
    for (const fn of pi.handlers["tool_call"] ?? []) await fn(ev as any, {} as any)
    return (ev.input.command as string) === "git status"
  })())
  w.restore()
}

// --- Scenario 2: already-rtk detection incl. env prefixes (no rewrite probe) ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = () => OK_VERSION
  await ext(pi as any)
  const before = pi.rewriteExecCount()
  check("s2: plain rtk unchanged", (await pi.fireToolCall("rtk ls -la")) === "rtk ls -la")
  check("s2: bare rtk unchanged", (await pi.fireToolCall("rtk")) === "rtk")
  check("s2: env-prefixed rtk unchanged", (await pi.fireToolCall("FOO=1 rtk ls")) === "FOO=1 rtk ls")
  check("s2: quoted env-prefixed rtk unchanged", (await pi.fireToolCall('FOO="a b" rtk ls')) === 'FOO="a b" rtk ls')
  check("s2: single-quoted env-prefixed rtk unchanged", (await pi.fireToolCall("FOO='a b' rtk ls")) === "FOO='a b' rtk ls")
  check("s2: multi env-prefixed rtk unchanged", (await pi.fireToolCall("A=1 B=2 rtk git status")) === "A=1 B=2 rtk git status")
  check("s2: leading-space rtk unchanged", (await pi.fireToolCall("  rtk ls")) === "  rtk ls")
  check("s2: rtkrewrite NOT treated as rtk", pi.rewriteExecCount() - before === 0)
  w.restore()
}

// --- Scenario 3: RTK_DISABLED escape hatch ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = () => OK_VERSION
  await ext(pi as any)
  process.env.RTK_DISABLED = "1"
  const before = pi.rewriteExecCount()
  check("s3: RTK_DISABLED=1 skips probe", (await pi.fireToolCall("git status")) === "git status" && pi.rewriteExecCount() === before)
  delete process.env.RTK_DISABLED
  w.restore()
}

// --- Scenario 4: exit 2 denied warns once ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = (_cmd, args) =>
    args[0] === "--version" ? OK_VERSION : { code: 2, stdout: "", stderr: "dangerous command", killed: false }
  await ext(pi as any)
  check("s4: denied passes through", (await pi.fireToolCall("rm -rf x")) === "rm -rf x")
  await pi.fireToolCall("rm -rf y")
  const deniedWarns = w.warnings.filter((x) => x.includes("denied")).length
  check("s4: denied warned exactly once", deniedWarns === 1)
  w.restore()
}

// --- Scenario 5: killed (timeout) is passthrough, not unavailability ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = (_cmd, args) =>
    args[0] === "--version" ? OK_VERSION : { code: 1, stdout: "", stderr: "", killed: true }
  await ext(pi as any)
  check("s5: killed passes through", (await pi.fireToolCall("git status")) === "git status")
  check("s5: still probing after kill (not marked unavailable)", pi.rewriteExecCount() === 1 && (await pi.fireToolCall("ls"), pi.rewriteExecCount() === 2))
  w.restore()
}

// --- Scenario 6: mid-session failure -> cached skip -> recovery after 30s ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  let rtkAlive = true
  pi.execImpl = (_cmd, args) => {
    if (!rtkAlive) throw new Error("spawn rtk ENOENT")
    if (args[0] === "--version") return OK_VERSION
    if (args[1] === "git status") return { code: 0, stdout: "rtk git status\n", stderr: "", killed: false }
    return { code: 1, stdout: "", stderr: "", killed: false }
  }
  Date.now = () => fakeNow
  await ext(pi as any)
  check("s6: rewrite works while alive", (await pi.fireToolCall("git status")) === "rtk git status")
  rtkAlive = false
  check("s6: failure passes through", (await pi.fireToolCall("git status")) === "git status")
  const countAfterFailure = pi.rewriteExecCount()
  await pi.fireToolCall("git status")
  await pi.fireToolCall("ls")
  check("s6: unavailable cached, no more rewrite execs within 30s", pi.rewriteExecCount() === countAfterFailure)
  rtkAlive = true
  fakeNow += 31_000
  check("s6: recovers after 30s re-probe", (await pi.fireToolCall("git status")) === "rtk git status")
  Date.now = realDateNow
  w.restore()
}

// --- Scenario 7: missing at load -> starts paused, self-heals ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  let rtkAlive = false
  pi.execImpl = (_cmd, args) => {
    if (!rtkAlive) throw new Error("spawn rtk ENOENT")
    if (args[0] === "--version") return OK_VERSION
    if (args[1] === "git status") return { code: 0, stdout: "rtk git status\n", stderr: "", killed: false }
    return { code: 1, stdout: "", stderr: "", killed: false }
  }
  Date.now = () => fakeNow
  await ext(pi as any)
  check("s7: handler registered even when missing at load", (pi.handlers["tool_call"] ?? []).length === 1)
  const execsAtStart = pi.execCalls.length
  await pi.fireToolCall("git status")
  check("s7: no rewrite exec while cached-missing", pi.execCalls.length === execsAtStart)
  rtkAlive = true
  fakeNow += 31_000
  check("s7: self-heals after 30s", (await pi.fireToolCall("git status")) === "rtk git status")
  Date.now = realDateNow
  w.restore()
}

// --- Scenario 8: too-old rtk disables extension ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = () => ({ code: 0, stdout: "rtk 0.22.1", stderr: "", killed: false })
  await ext(pi as any)
  check("s8: too-old rtk registers no tool_call handler", (pi.handlers["tool_call"] ?? []).length === 0)
  check("s8: too-old warned", w.warnings.some((x) => x.includes("too old")))
  w.restore()
}

// --- Scenario 9: bash output tail-risk cap ---
{
  const w = silenceWarns()
  const pi = new MockPi()
  pi.execImpl = () => OK_VERSION
  await ext(pi as any)
  const fireResult = async (text: string, toolName = "bash") => {
    const event = { toolName, toolCallId: "x", input: {}, content: [{ type: "text", text }], isError: false }
    for (const fn of pi.handlers["tool_result"] ?? []) {
      const ret = await fn(event, {} as any)
      if (ret?.content) event.content = ret.content
    }
    return (event.content[0] as any).text as string
  }

  const small = "x".repeat(39_999)
  check("s9: small output untouched", (await fireResult(small)) === small)

  const big = "H".repeat(30_000) + "M".repeat(20_000) + "T".repeat(15_000) // 65k chars
  const out = await fireResult(big)
  check("s9: big output truncated", out.length < 41_000)
  check("s9: head preserved", out.startsWith("H".repeat(100)))
  check("s9: tail preserved", out.endsWith("T".repeat(100)))
  check("s9: marker present with counts", out.includes("[rtk: omitted") && out.includes("65000-char"))
  check("s9: exact head+tail accounting", out.includes("H".repeat(24_000)) && out.includes("T".repeat(12_000)))
  check("s9: non-bash result untouched", (await fireResult(big, "read")) === big)

  // image blocks pass through
  const ev = { toolName: "bash", toolCallId: "x", input: {}, content: [{ type: "image", data: "abc" }], isError: false }
  for (const fn of pi.handlers["tool_result"] ?? []) await fn(ev as any, {} as any)
  check("s9: image block untouched", (ev.content[0] as any).data === "abc")
  w.restore()
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
