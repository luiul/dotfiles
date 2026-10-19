// Mock-harness test for the zsh-bang pi extension.
// Registers the real user_bash handler via a stubbed ExtensionAPI, then drives
// the returned BashOperations.exec with real `zsh -ic` spawns, asserting marker
// stripping, zsh execution, stderr noise filtering, and abort cleanup.
import ext from "../pi/.pi/agent/extensions/zsh-bang.ts"

type ExecOptions = {
  onData: (data: Buffer) => void
  signal?: AbortSignal
  timeout?: number
  env?: NodeJS.ProcessEnv
}
type ExecResult = { exitCode: number | null }
interface BashOperationsLike {
  exec: (command: string, cwd: string, options: ExecOptions) => Promise<ExecResult>
}

class MockPi {
  handlers: Record<string, Function[]> = {}
  on(_event: string, fn: Function) {
    ;(this.handlers[_event] ??= []).push(fn)
  }
  fireUserBash(command: string) {
    const event = { type: "user_bash", command, excludeFromContext: true, cwd: process.cwd() }
    for (const fn of this.handlers["user_bash"] ?? []) {
      const result = fn(event, {})
      if (result !== undefined) return result
    }
    return undefined
  }
}

async function runExec(ops: BashOperationsLike, command: string, signal?: AbortSignal) {
  const chunks: Buffer[] = []
  const result = await ops.exec(command, process.cwd(), {
    onData: (chunk) => chunks.push(chunk),
    signal,
  })
  return { output: Buffer.concat(chunks).toString(), exitCode: result.exitCode }
}

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}`)
  }
}

const pi = new MockPi()
ext(pi as never)

// --- Handler routing ---
{
  const passthrough = pi.fireUserBash("ls -la")
  check("plain !! command passes through (undefined)", passthrough === undefined)

  const marked = pi.fireUserBash("!type gurl")
  check(
    "marker command returns { operations }",
    marked !== undefined && typeof (marked as { operations?: unknown }).operations === "object",
  )

  const onlyBang = pi.fireUserBash("!")
  check("bare marker returns operations too", onlyBang !== undefined)

  const ops = (marked as unknown as { operations: BashOperationsLike }).operations
  check("operations has an exec function", typeof ops.exec === "function")

  // --- exec: marker stripping and real zsh ---
  const echo = await runExec(ops, "!echo zsh-ok")
  check("marker stripped, command ran in zsh", echo.output === "zsh-ok\n")
  check("exit code 0", echo.exitCode === 0)

  const shellName = await runExec(ops, "!echo $0")
  check("command runs under zsh, not bash", shellName.output.trim().endsWith("zsh"))

  // --- exec: zsh config actually loaded (the whole point of the extension) ---
  const gurlType = await runExec(ops, "!type gurl")
  check("interactive zsh config loaded (gurl resolves)", gurlType.output.includes("function"))

  // --- exec: zle startup noise filtered out of stderr ---
  check("no zle noise in output", !gurlType.output.includes("can't change option: zle"))

  // --- exec: empty command after marker ---
  const empty = await runExec(ops, "!")
  check("empty command exits 0 with hint", empty.exitCode === 0 && empty.output.includes("zsh-bang:"))

  // --- exec: real stderr survives the noise filter ---
  const stderrCase = await runExec(ops, "!echo real-error >&2")
  check("real stderr passes through", stderrCase.output === "real-error\n")
  check("failing command reports nonzero exit", (await runExec(ops, "!exit 42")).exitCode === 42)

  // --- abort: killed group, no orphan zsh ---
  {
    const controller = new AbortController()
    const chunks: Buffer[] = []
    const promise = ops.exec("!sleep 30", process.cwd(), {
      onData: (chunk) => chunks.push(chunk),
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 700)) // let zsh config load and sleep start
    controller.abort()
    let aborted = false
    try {
      await promise
    } catch (err) {
      aborted = err instanceof Error && err.message === "aborted"
    }
    check("abort mid-run throws 'aborted'", aborted)
    await new Promise((r) => setTimeout(r, 300))
    const { execSync } = await import("node:child_process")
    const leftovers = execSync("pgrep -fl 'zsh:.*sleep 30' || true").toString().trim()
    check("no orphan zsh after abort", leftovers === "")
  }

  // --- grace: background descendant holding the pipes must not hang exec ---
  {
    const t0 = Date.now()
    const bg = await runExec(ops, "!sleep 8 &")
    const elapsed = (Date.now() - t0) / 1000
    check("background job does not hang exec (grace timer)", bg.exitCode === 0 && elapsed < 6.5)
    const { execSync } = await import("node:child_process")
    // The sleep itself deliberately keeps running (user asked for &); clean it
    // up here so the test leaves nothing behind.
    execSync("pkill -f 'sleep 8' || true")
  }
}

if (failures === 0) console.log("\nALL PASS")
else {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
