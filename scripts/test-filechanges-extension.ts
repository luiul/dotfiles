// Mock-harness test for the filechanges pi extension (session-cumulative model).
// Drives the real extension file with a stubbed ExtensionAPI, real temp files,
// and a real temp git repo, asserting Session set accumulation, Revert,
// bash-driven detection, Clear semantics, and reload-restore.
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import ext from "../pi/.pi/agent/extensions/filechanges.ts"

const execFileAsync = promisify(execFile)

class MockPi {
  handlers: Record<string, Function[]> = {}
  commands: Record<string, { description: string; handler: Function }> = {}
  appended: { type: string; data: any }[] = []
  on(event: string, fn: Function) {
    ;(this.handlers[event] ??= []).push(fn)
  }
  registerCommand(name: string, def: { description: string; handler: Function }) {
    this.commands[name] = def
  }
  appendEntry(type: string, data: any) {
    this.appended.push({ type, data })
  }
  latestSessionSetEntry(): any {
    for (let i = this.appended.length - 1; i >= 0; i--) {
      if (this.appended[i].type === "filechanges:session-set") return this.appended[i].data
    }
    return null
  }
}

class MockCtx {
  cwd: string
  hasUI = true
  widgets: Record<string, string[] | undefined> = {}
  statuses: Record<string, unknown> = {}
  notifications: string[] = []
  branchEntries: any[] = []
  ui = {
    theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
    setWidget: (id: string, lines: string[] | undefined) => (this.widgets[id] = lines),
    setStatus: (id: string, text: unknown) => (this.statuses[id] = text),
    notify: (text: string, _level: string) => this.notifications.push(text),
  }
  sessionManager = { getBranch: () => this.branchEntries }
  constructor(cwd: string) {
    this.cwd = cwd
  }
  async waitForIdle() {}
  panel(): string[] | undefined {
    return this.widgets["filechanges"]
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fire(pi: MockPi, event: string, ev: any, ctx: MockCtx) {
  for (const fn of pi.handlers[event] ?? []) await fn(ev, ctx)
}

// Simulate one edit/write tool call cycle against a real file.
async function editFile(pi: MockPi, ctx: MockCtx, id: string, path: string, content: string | null) {
  await fire(pi, "tool_call", { toolName: "write", input: { path }, toolCallId: id }, ctx)
  if (content === null) await unlink(join(ctx.cwd, path)).catch(() => {})
  else await writeFile(join(ctx.cwd, path), content, "utf-8")
  await fire(pi, "tool_result", { toolName: "write", toolCallId: id, isError: false }, ctx)
  await sleep(2) // keep updatedAt ordering deterministic
}

// Simulate one bash tool call cycle; `during` runs while the call is "in flight".
async function bash(pi: MockPi, ctx: MockCtx, id: string, command: string, during: () => Promise<void>) {
  await fire(pi, "tool_call", { toolName: "bash", input: { command }, toolCallId: id }, ctx)
  await during()
  await fire(pi, "tool_result", { toolName: "bash", toolCallId: id, isError: false }, ctx)
  await sleep(2)
}

const dir = await mkdtemp(join(tmpdir(), "fc-test-"))
await execFileAsync("git", ["init"], { cwd: dir })
// A file committed at HEAD, for bash and restore scenarios.
await writeFile(join(dir, "committed.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dir })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir })

// --- Scenario 1: Session set accumulates across prompts, persists on settle ---
const pi = new MockPi()
const ctx = new MockCtx(dir)
await ext(pi as any)

await editFile(pi, ctx, "1", "a.txt", "hello\n")
check("s1: panel shows 1 created row", ctx.panel()?.join("\n") === `Session changes (1):\ncreated  a.txt (+1/-0)`)
check("s1: no footer status is set", Object.keys(ctx.statuses).length === 0)
await fire(pi, "agent_settled", {}, ctx)
check("s1: settle persists the set", pi.latestSessionSetEntry()?.items?.length === 1)

// Second "prompt": the set must NOT reset.
await editFile(pi, ctx, "2", "b.txt", "one\ntwo\n")
check("s1: set accumulates across prompts", ctx.panel()?.[0] === "Session changes (2):")
check(
  "s1: rows sorted most-recently-touched first",
  ctx.panel()?.[1]?.startsWith("created  b.txt (+2/-0)") === true && ctx.panel()?.[2]?.startsWith("created  a.txt (+1/-0)") === true,
)
await fire(pi, "agent_settled", {}, ctx)
check("s1: settle persists both", pi.latestSessionSetEntry()?.items?.length === 2)

// --- Scenario 2: Revert drops the entry automatically ---
// Existing file: capture Original at first touch, modify, then restore content.
await writeFile(join(dir, "c.txt"), "orig\n", "utf-8")
await editFile(pi, ctx, "3", "c.txt", "changed\n")
check("s2: modified row appears", ctx.panel()?.join("\n").includes("modified c.txt (+1/-1)") === true)
await editFile(pi, ctx, "4", "c.txt", "orig\n") // back to its Original
check("s2: reverted file drops off the set", ctx.panel()?.[0] === "Session changes (2):" && !ctx.panel()?.join("\n").includes("c.txt"))
// Created file reverts by being deleted.
await editFile(pi, ctx, "5", "a.txt", null)
check("s2: deleting a created file reverts it", ctx.panel()?.[0] === "Session changes (1):" && !ctx.panel()?.join("\n").includes("a.txt"))

// --- Scenario 3: bash-driven change detection (git repo) ---
await bash(pi, ctx, "6", "echo x > bash-new.txt && echo more >> committed.txt", async () => {
  await writeFile(join(dir, "bash-new.txt"), "x\ny\n", "utf-8")
  await writeFile(join(dir, "committed.txt"), "base\nmore\n", "utf-8")
})
const s3panel = ctx.panel()?.join("\n") ?? ""
check("s3: bash-created file tracked", s3panel.includes("created  bash-new.txt (+2/-0)"))
check("s3: bash-modified file tracked (vs HEAD)", s3panel.includes("modified committed.txt (+1/-0)"))
check("s3: header counts all rows", s3panel.startsWith("Session changes (3):"))
// Ignored paths touched by bash must not appear.
await bash(pi, ctx, "7", "echo '{}' > package-lock.json", async () => {
  await writeFile(join(dir, "package-lock.json"), "{}", "utf-8")
})
check("s3: ignored lockfile not tracked", !(ctx.panel()?.join("\n") ?? "").includes("package-lock.json"))

// --- Scenario 4: overflow cap (8 rows + overflow line = 10 lines max) ---
for (let i = 0; i < 7; i++) await editFile(pi, ctx, `8.${i}`, `f${i}.txt`, `row ${i}\n`)
const s4panel = ctx.panel() ?? []
check("s4: panel capped at 10 lines", s4panel.length === 10)
check("s4: header shows full count", s4panel[0] === "Session changes (10):")
check("s4: overflow line points to /filechanges", s4panel[9] === "…and 2 more (see /filechanges)")
// /filechanges prints everything.
ctx.notifications = []
await pi.commands["filechanges"].handler("", ctx)
check("s4: /filechanges lists all 10 rows", (ctx.notifications[0]?.match(/\n/g)?.length ?? 0) === 10 && ctx.notifications[0].startsWith("Session changes (10):"))

// --- Scenario 5: Clear empties the set AND forgets Originals ---
await fire(pi, "agent_settled", {}, ctx)
await pi.commands["filechanges-clear"].handler("", ctx)
check("s5: clear hides the panel", ctx.panel() === undefined)
check("s5: clear persists the empty set", pi.latestSessionSetEntry()?.items?.length === 0)
// b.txt had 2 lines at Clear time and is now tracked again from that state.
await editFile(pi, ctx, "9", "b.txt", "one\ntwo\nthree\n")
check("s5: counts measured from post-Clear state", ctx.panel()?.join("\n") === `Session changes (1):\nmodified b.txt (+1/-0)`)

// --- Scenario 6: reload restores the set and re-captures Originals from HEAD ---
await fire(pi, "agent_settled", {}, ctx)
const persisted = pi.latestSessionSetEntry()
const pi2 = new MockPi()
const ctx2 = new MockCtx(dir)
ctx2.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: persisted }]
await ext(pi2 as any)
await fire(pi2, "session_start", {}, ctx2)
check("s6: panel restored after reload", ctx2.panel()?.[0] === "Session changes (1):")
check("s6: restored counts stay as recorded", ctx2.panel()?.join("\n").includes("modified b.txt (+1/-0)") === true)
// committed.txt (HEAD: "base\n", working tree: "base\nmore\n") was persisted as
// modified (+1/-0) in scenario 3; after reload its Original is re-captured from
// HEAD, so the next edit counts against HEAD, not against the frozen row.
const withCommitted = pi.appended.map((a) => a.data).filter((d) => d?.items?.some((i: any) => i.path === "committed.txt")).pop()
const restoredCommitted = withCommitted?.items?.find((i: any) => i.path === "committed.txt")
check("s6: bash row persisted earlier", restoredCommitted?.kind === "modified" && restoredCommitted?.added === 1)
const pi3 = new MockPi()
const ctx3 = new MockCtx(dir)
ctx3.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: withCommitted }]
await ext(pi3 as any)
await fire(pi3, "session_start", {}, ctx3)
check("s6: multi-row restore", (ctx3.panel()?.[0] ?? "") === `Session changes (${withCommitted.items.length}):`)
await editFile(pi3, ctx3, "10", "committed.txt", "base\nmore\neven-more\n")
// HEAD re-capture: counts vs HEAD ("base\n"), so +2/-0, not +1/-0.
check("s6: post-restore edit counts vs HEAD", ctx3.panel()?.join("\n").includes("modified committed.txt (+2/-0)") === true)

// Malformed/old-format entries are dropped, not crashed on.
const pi4 = new MockPi()
const ctx4 = new MockCtx(dir)
ctx4.branchEntries = [
  { type: "custom", customType: "filechanges:batch", data: { items: [{ path: "old.txt", kind: "new" }] } }, // old key: ignored
  { type: "custom", customType: "filechanges:session-set", data: { items: [{ path: "bad.txt", kind: "new" }, null, { nope: 1 }] } },
]
await ext(pi4 as any)
await fire(pi4, "session_start", {}, ctx4)
check("s6: old batch key and malformed rows ignored, panel hidden", ctx4.panel() === undefined)

// --- Scenario 7: restore outside a git repo keeps counts frozen ---
const dirPlain = await mkdtemp(join(tmpdir(), "fc-plain-"))
await writeFile(join(dirPlain, "x.txt"), "1\n", "utf-8")
const pi5 = new MockPi()
const ctx5 = new MockCtx(dirPlain)
ctx5.branchEntries = [
  {
    type: "custom",
    customType: "filechanges:session-set",
    data: { items: [{ path: "x.txt", absPath: join(dirPlain, "x.txt"), kind: "modified", added: 5, removed: 2, binary: false, updatedAt: 1 }] },
  },
]
await ext(pi5 as any)
await fire(pi5, "session_start", {}, ctx5)
check("s7: outside-repo restore keeps frozen counts", ctx5.panel()?.join("\n") === `Session changes (1):\nmodified x.txt (+5/-2)`)

// --- Scenario 8: bash changes OUTSIDE the cwd repo are tracked via path sniffing ---
const dirOther = await mkdtemp(join(tmpdir(), "fc-other-"))
await execFileAsync("git", ["init"], { cwd: dirOther })
await writeFile(join(dirOther, "other-committed.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dirOther })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dirOther })
// Pre-session dirt in the other repo: the Original must be the pre-call
// content, not that repo's HEAD.
await writeFile(join(dirOther, "other-committed.txt"), "base\ndirty\n", "utf-8")
const dirNoRepo = await mkdtemp(join(tmpdir(), "fc-norepo-"))

const pi6 = new MockPi()
const ctx6 = new MockCtx(dir)
await ext(pi6 as any)

// 8a: absolute redirect target in another git repo.
await bash(pi6, ctx6, "s8.1", `printf 'hello\n' > ${join(dirOther, "outside.txt")}`, async () => {
  await writeFile(join(dirOther, "outside.txt"), "hello\n", "utf-8")
})
check(
  "s8: created file in another repo is tracked (absolute path)",
  ctx6.panel()?.join("\n").includes(`created  ${join(dirOther, "outside.txt")} (+1/-0)`) === true,
)

// 8b: modify a pre-dirty file in another repo: +1/-0 vs pre-call content, not +2/-0 vs its HEAD.
await bash(pi6, ctx6, "s8.2", `echo new >> ${join(dirOther, "other-committed.txt")}`, async () => {
  await writeFile(join(dirOther, "other-committed.txt"), "base\ndirty\nnew\n", "utf-8")
})
check(
  "s8: counts vs pre-call content, not the other repo's HEAD",
  ctx6.panel()?.join("\n").includes(`modified ${join(dirOther, "other-committed.txt")} (+1/-0)`) === true,
)

// 8c: relative path after `cd` into a non-repo dir (virtual cwd).
await bash(pi6, ctx6, "s8.3", `cd ${dirNoRepo} && echo hi > plain.txt`, async () => {
  await writeFile(join(dirNoRepo, "plain.txt"), "hi\n", "utf-8")
})
check(
  "s8: relative path after cd into a non-repo dir is tracked",
  ctx6.panel()?.join("\n").includes(`created  ${join(dirNoRepo, "plain.txt")} (+1/-0)`) === true,
)

// 8d: a command that only reads an outside file tracks nothing new.
await bash(pi6, ctx6, "s8.4", `cat ${join(dirOther, "outside.txt")}`, async () => {})
check("s8: read-only command tracks nothing", ctx6.panel()?.[0] === "Session changes (3):")

// 8e: deleting an outside created file reverts it off the set.
await bash(pi6, ctx6, "s8.5", `rm ${join(dirNoRepo, "plain.txt")}`, async () => {
  await rm(join(dirNoRepo, "plain.txt"))
})
check(
  "s8: deleting an outside created file reverts it",
  ctx6.panel()?.[0] === "Session changes (2):" && !ctx6.panel()?.join("\n").includes("plain.txt"),
)

// 8f: an in-repo file named in the command is tracked once, not duplicated by the git diff.
await bash(pi6, ctx6, "s8.6", "echo z > sniff-inrepo.txt", async () => {
  await writeFile(join(dir, "sniff-inrepo.txt"), "z\n", "utf-8")
})
const s8rows = (ctx6.panel() ?? []).filter((l) => l.includes("sniff-inrepo.txt"))
check(
  "s8: in-repo sniffed file appears exactly once",
  s8rows.length === 1 && s8rows[0].startsWith("created  sniff-inrepo.txt (+1/-0)"),
)

await rm(dir, { recursive: true, force: true })
await rm(dirPlain, { recursive: true, force: true })
await rm(dirOther, { recursive: true, force: true })
await rm(dirNoRepo, { recursive: true, force: true })

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
