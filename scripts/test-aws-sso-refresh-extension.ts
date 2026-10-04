// Mock-harness test for the aws-sso-refresh pi extension.
// Drives the real extension file with a stubbed ExtensionAPI and a fake
// `aws` binary first in PATH, asserting fully lazy behavior: no AWS calls at
// startup or model select, login only right before a Bedrock model call.
//
// Run: bun scripts/test-aws-sso-refresh-extension.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chmodSync } from "node:fs"

// --- fake aws binary -------------------------------------------------------
// Logs every invocation to FAKE_AWS_LOG. `sts get-caller-identity` exits 0
// only when FAKE_AWS_STATE contains "valid"; `sso login` flips state to valid
// (mirrors the real flow) and exits 0 without any browser.
const dir = mkdtempSync(join(tmpdir(), "aws-sso-refresh-test-"))
const log = join(dir, "aws.log")
const state = join(dir, "state")
writeFileSync(state, "expired")
writeFileSync(log, "")
const fakeAws = join(dir, "aws")
writeFileSync(
  fakeAws,
  `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "sts" ]; then
  [ "$(cat "${state}")" = "valid" ] && exit 0 || exit 1
fi
if [ "$1" = "sso" ] && [ "$2" = "login" ]; then
  echo valid > "${state}"
  exit 0
fi
exit 0
`,
)
chmodSync(fakeAws, 0o755)

// Env must be set before importing the extension (it snapshots AWS_PROFILE
// and builds its cross-process lockfile path from it at module load).
process.env.PATH = `${dir}:${process.env.PATH}`
process.env.AWS_PROFILE = "sso-test"

const { default: ext } = await import("../pi/.pi/agent/extensions/aws-sso-refresh.ts")

// --- stub ExtensionAPI / ExtensionContext -----------------------------------
class MockPi {
  handlers: Record<string, Function[]> = {}
  commands: Record<string, Function> = {}
  on(event: string, fn: Function) {
    ;(this.handlers[event] ??= []).push(fn)
  }
  registerCommand(name: string, opts: { handler: Function }) {
    this.commands[name] = opts.handler
  }
  async fire(event: string, provider: string) {
    const ctx = { model: { provider }, ui: { notify } }
    for (const fn of this.handlers[event] ?? []) await fn({}, ctx)
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
const awsCalls = (): string[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
const clearLog = () => writeFileSync(log, "")
const setState = (s: string) => writeFileSync(state, s)
const count = (re: RegExp) => awsCalls().filter((l) => re.test(l)).length

// --- scenario ----------------------------------------------------------------
const pi = new MockPi()
await ext(pi as any)

check("no session_start handler registered", !pi.handlers["session_start"])
check("no model_select handler registered", !pi.handlers["model_select"])
check("before_agent_start handler registered", (pi.handlers["before_agent_start"] ?? []).length === 1)
check("/sso command registered", typeof pi.commands["sso"] === "function")

// Router turn with an expired session: zero AWS activity.
setState("expired")
clearLog()
await pi.fire("before_agent_start", "ai-model-router")
check("router turn makes no aws calls", awsCalls().length === 0)

// Bedrock turn with an expired session: THE lazy login, at turn time only.
// sessionValid retries once on failure, so expect 2 sts probes then 1 login.
clearLog()
await pi.fire("before_agent_start", "amazon-bedrock")
check("expired bedrock turn probes sts (with 1 retry)", count(/^sts get-caller-identity/) === 2)
check("expired bedrock turn logs in exactly once", count(/^sso login/) === 1)
check("login notify shown", notes.some((n) => n.includes("opening browser")))
check("refreshed notify shown", notes.some((n) => n.includes("refreshed")))

// Next turn right after: throttled by VALIDATE_TTL_MS, no new probe.
clearLog()
await pi.fire("before_agent_start", "amazon-bedrock")
check("valid bedrock turn within TTL makes no aws calls", awsCalls().length === 0)

// Session expires mid-TTL-window: pre-turn check still skips (accepted
// tradeoff of throttling); /sso force bypasses the TTL and re-logs in.
setState("expired")
clearLog()
await pi.commands["sso"]("", { model: { provider: "amazon-bedrock" }, ui: { notify } })
check("/sso with expired session probes sts (with 1 retry)", count(/^sts get-caller-identity/) === 2)
check("/sso with expired session logs in once", count(/^sso login/) === 1)

// /sso with a valid session: probe only, no login.
clearLog()
await pi.commands["sso"]("", { model: { provider: "amazon-bedrock" }, ui: { notify } })
check("/sso with valid session probes sts once", count(/^sts get-caller-identity/) === 1)
check("/sso with valid session does not log in", count(/^sso login/) === 0)

// No stale cross-process lockfile left behind.
check("login lockfile released", !existsSync(join(tmpdir(), "pi-aws-sso-login-sso-test.lock")))

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
