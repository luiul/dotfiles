// Test the cumulative Session set through the real extension and UI components.
// Real files and Git repos cover Revert, bash detection, Clear, restore, prompt
// activity, semantic colors, Repo state refreshes, and ignored paths.
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import ext, { FileChangesList, __setTmpRootsForTest } from "../pi/.pi/agent/extensions/filechanges.ts"
import { getSharedFileChangesTracker } from "../pi/.pi/agent/extensions/filechanges-tracker.ts"

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
  colorize: boolean
  mode = "tui"
  hasUI = true
  widgets: Record<string, { render: (width: number) => string[] } | string[] | undefined> = {}
  listLines: string[] = []
  listCount = 0
  renderRequests = 0
  foregrounds: { color: string; text: string }[] = []
  boldTexts: string[] = []
  tui = { terminal: { rows: 1000 }, requestRender: () => this.renderRequests++ }
  statuses: Record<string, unknown> = {}
  notifications: string[] = []
  branchEntries: any[] = []
  ui = {
    // Record semantic color calls without adding visible test markers to paths.
    theme: {
      colors: {},
      fg: (color: string, text: string) => {
        if (this.colorize) this.foregrounds.push({ color, text })
        return text
      },
      bold: (text: string) => {
        if (this.colorize) this.boldTexts.push(text)
        return text
      },
    },
    setWidget: (id: string, widget: any) => {
      this.widgets[id] = typeof widget === "function" ? widget(this.tui, this.ui.theme) : widget
    },
    custom: async (factory: Function, options: any) => {
      check("/filechanges hides the persistent Panel before opening its List", this.panel() === undefined)
      check("/filechanges uses a bounded overlay rather than the editor slot", options?.overlay === true && options.overlayOptions.width === "100%")
      const list = factory(this.tui, this.ui.theme, { matches: () => false }, () => {})
      check("/filechanges opens the real List component", list instanceof FileChangesList)
      this.listCount++
      this.listLines = list.render(1000)
      return undefined
    },
    setStatus: (id: string, text: unknown) => (this.statuses[id] = text),
    notify: (text: string, _level: string) => this.notifications.push(text),
  }
  sessionManager = { getBranch: () => this.branchEntries }
  constructor(cwd: string, opts?: { colorize?: boolean }) {
    this.cwd = cwd
    this.colorize = opts?.colorize ?? false
  }
  async waitForIdle() {}
  panel(): string[] | undefined {
    const widget = this.widgets["filechanges"]
    return Array.isArray(widget) ? widget : widget?.render(1000)
  }
  colored(color: string, text: string): boolean {
    return this.foregrounds.some((call) => call.color === color && call.text.trim() === text)
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
  if (content === null) await unlink(resolve(ctx.cwd, path)).catch(() => {})
  else await writeFile(resolve(ctx.cwd, path), content, "utf-8")
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

const fixtures: string[] = []
async function fixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  fixtures.push(dir)
  return dir
}

try {
const dir = await fixture("fc-test-")
await execFileAsync("git", ["init"], { cwd: dir })
// The tmp filter would swallow every fixture below (they all live in the real
// tmpdir), so the seam points it at a dedicated fixture root instead.
const tmpExcluded = await fixture("fc-tmpexcluded-")
__setTmpRootsForTest([tmpExcluded])
// A file committed at HEAD, for bash and restore scenarios.
await writeFile(join(dir, "committed.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dir })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir })

// --- Scenario 1: Session set accumulates across prompts, persists on settle ---
const pi = new MockPi()
const ctx = new MockCtx(dir)
await ext(pi as any)

await editFile(pi, ctx, "1", "a.txt", "hello\n")
check("s1: panel shows 1 created row", ctx.panel()?.join("\n") === `│ Session changes: 1 file  +1/-0  ·  1 this prompt\n│ created  a.txt +1/-0  this prompt`)
check("s1: no footer status is set", Object.keys(ctx.statuses).length === 0)
await fire(pi, "agent_settled", {}, ctx)
check("s1: settle persists the set", pi.latestSessionSetEntry()?.items?.length === 1)

// Second "prompt": the set must NOT reset.
await editFile(pi, ctx, "2", "b.txt", "one\ntwo\n")
check("s1: set accumulates across edits", ctx.panel()?.[0] === "│ Session changes: 2 files  +3/-0  ·  2 this prompt")
check(
  "s1: rows sorted most-recently-touched first",
  ctx.panel()?.[1]?.startsWith("│ created  b.txt +2/-0") === true && ctx.panel()?.[2]?.startsWith("│ created  a.txt +1/-0") === true,
)
await fire(pi, "agent_settled", {}, ctx)
check("s1: settle persists both", pi.latestSessionSetEntry()?.items?.length === 2)

// --- Scenario 2: Revert drops the entry automatically ---
// Existing file: capture Original at first touch, modify, then restore content.
await writeFile(join(dir, "c.txt"), "orig\n", "utf-8")
await editFile(pi, ctx, "3", "c.txt", "changed\n")
check("s2: modified row appears", ctx.panel()?.join("\n").includes("modified c.txt +1/-1") === true)
await editFile(pi, ctx, "4", "c.txt", "orig\n") // back to its Original
check("s2: reverted file drops off the set", ctx.panel()?.[0] === "│ Session changes: 2 files  +3/-0  ·  2 this prompt" && !ctx.panel()?.join("\n").includes("c.txt"))
// Created file reverts by being deleted.
await editFile(pi, ctx, "5", "a.txt", null)
check("s2: deleting a created file reverts it", ctx.panel()?.[0] === "│ Session changes: 1 file  +2/-0  ·  1 this prompt" && !ctx.panel()?.join("\n").includes("a.txt"))

// --- Scenario 3: bash-driven change detection (git repo) ---
await bash(pi, ctx, "6", "echo x > bash-new.txt && echo more >> committed.txt", async () => {
  await writeFile(join(dir, "bash-new.txt"), "x\ny\n", "utf-8")
  await writeFile(join(dir, "committed.txt"), "base\nmore\n", "utf-8")
})
const s3panel = ctx.panel()?.join("\n") ?? ""
check("s3: bash-created file tracked", s3panel.includes("created  bash-new.txt +2/-0"))
check("s3: bash-modified file tracked (vs HEAD)", s3panel.includes("modified committed.txt +1/-0"))
check("s3: header counts all rows", s3panel.startsWith("│ Session changes: 3 files"))
// Ignored paths touched by bash must not appear.
await bash(pi, ctx, "7", "echo '{}' > package-lock.json", async () => {
  await writeFile(join(dir, "package-lock.json"), "{}", "utf-8")
})
check("s3: ignored lockfile not tracked", !(ctx.panel()?.join("\n") ?? "").includes("package-lock.json"))

// --- Scenario 4: six rows plus summary and overflow (eight lines total) ---
for (let i = 0; i < 7; i++) await editFile(pi, ctx, `8.${i}`, `f${i}.txt`, `row ${i}\n`)
const s4panel = ctx.panel() ?? []
check("s4: panel capped at eight lines", s4panel.length === 8)
check("s4: panel shows six rows", s4panel.slice(1, -1).length === 6 && s4panel[1].includes("f6.txt") && s4panel[6].includes("f1.txt"))
check("s4: header shows full count and totals", s4panel[0] === "│ Session changes: 10 files  +12/-0  ·  10 this prompt")
check("s4: overflow line points to /filechanges", s4panel[7] === "│ 4 more · /filechanges")
// The requested List uses the real component and includes every file.
ctx.notifications = []
await pi.commands["filechanges"].handler("", ctx)
check("s4: /filechanges lists all 10 rows", ctx.listLines.length === 12 && ctx.listLines[0].startsWith("Session changes: 10 files") && ctx.listLines.some((line) => line.includes("b.txt")))
check("s4: full List does not use notifications", ctx.notifications.length === 0)
check("s4: closing the List restores the cumulative Panel", ctx.panel()?.length === 8)

const custom = ctx.ui.custom
let resolveList: () => void = () => {}
let rejectList: (error: Error) => void = () => {}
ctx.ui.custom = async () => new Promise<void>((resolve, reject) => { resolveList = resolve; rejectList = reject })
const pendingList = pi.commands["filechanges"].handler("", ctx)
for (let i = 0; i < 100 && ctx.panel() !== undefined; i++) await sleep(5)
check("s4: Panel remains hidden while the List is pending", ctx.panel() === undefined)
await editFile(pi, ctx, "list-update", "during-list.txt", "new\n")
check("s4: tracker updates cannot show a duplicate Panel while List is open", ctx.panel() === undefined)
resolveList()
await pendingList
check("s4: closing restores the latest tracker state", ctx.panel()?.join("\n").includes("during-list.txt") === true)
const failedList = pi.commands["filechanges"].handler("", ctx)
for (let i = 0; i < 100 && ctx.panel() !== undefined; i++) await sleep(5)
rejectList(new Error("test overlay failure"))
await failedList.catch(() => {})
check("s4: overlay failure restores the Panel", ctx.panel()?.length === 8)
ctx.ui.custom = custom
await editFile(pi, ctx, "list-revert", "during-list.txt", null)

// --- Scenario 5: Clear empties the set AND forgets Originals ---
await fire(pi, "agent_settled", {}, ctx)
await pi.commands["filechanges-clear"].handler("", ctx)
check("s5: clear hides the panel", ctx.panel() === undefined)
check("s5: clear persists the empty set", pi.latestSessionSetEntry()?.items?.length === 0)
// b.txt had 2 lines at Clear time and is now tracked again from that state.
await editFile(pi, ctx, "9", "b.txt", "one\ntwo\nthree\n")
check("s5: counts measured from post-Clear state", ctx.panel()?.join("\n") === `│ Session changes: 1 file  +1/-0  ·  1 this prompt\n│ modified b.txt +1/-0  this prompt`)

// --- Scenario 6: reload restores the set and re-captures Originals from HEAD ---
await fire(pi, "agent_settled", {}, ctx)
const persisted = pi.latestSessionSetEntry()
const pi2 = new MockPi()
const ctx2 = new MockCtx(dir)
ctx2.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: persisted }]
await ext(pi2 as any)
await fire(pi2, "session_start", {}, ctx2)
check("s6: panel restored after reload", ctx2.panel()?.[0]?.startsWith("│ Session changes: 1 file  +1/-0") === true)
check("s6: restored counts stay as recorded", ctx2.panel()?.join("\n").includes("modified b.txt +1/-0") === true)
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
const sumA = withCommitted.items.reduce((n: number, i: any) => n + i.added, 0)
const sumR = withCommitted.items.reduce((n: number, i: any) => n + i.removed, 0)
check("s6: multi-row restore", (ctx3.panel()?.[0] ?? "").startsWith(`│ Session changes: ${withCommitted.items.length} files  +${sumA}/-${sumR}`))
await editFile(pi3, ctx3, "10", "committed.txt", "base\nmore\neven-more\n")
// HEAD re-capture: counts vs HEAD ("base\n"), so +2/-0, not +1/-0.
const postRestore = getSharedFileChangesTracker(pi3 as any, ctx3 as any).getChanges()
const restoredRows = postRestore.filter((item) => item.path === "committed.txt")
check("s6: post-restore edit does not duplicate logical and physical paths", restoredRows.length === 1)
check("s6: post-restore edit counts vs HEAD", ctx3.panel()?.join("\n").includes("modified committed.txt +2/-0") === true)
if (restoredRows.length !== 1 || restoredRows[0]?.added !== 2) {
  console.log("s6 diagnostic:", JSON.stringify({ cwd: dir, persisted: restoredCommitted, current: restoredRows }))
}

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
const dirPlain = await fixture("fc-plain-")
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
// Legacy entries without activity metadata still show all cumulative rows.
check("s7: outside-repo restore keeps frozen counts", ctx5.panel()?.[0]?.startsWith("│ Session changes: 1 file  +5/-2") === true && ctx5.panel()?.[1]?.startsWith("│ modified x.txt +5/-2") === true)

// --- Scenario 8: bash changes OUTSIDE the cwd repo are tracked via path sniffing ---
const dirOther = await fixture("fc-other-")
await execFileAsync("git", ["init"], { cwd: dirOther })
await writeFile(join(dirOther, "other-committed.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dirOther })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dirOther })
// Pre-session dirt in the other repo: the Original must be the pre-call
// content, not that repo's HEAD.
await writeFile(join(dirOther, "other-committed.txt"), "base\ndirty\n", "utf-8")
const dirNoRepo = await fixture("fc-norepo-")

const pi6 = new MockPi()
const ctx6 = new MockCtx(dir)
await ext(pi6 as any)

// 8a: absolute redirect target in another git repo.
await bash(pi6, ctx6, "s8.1", `printf 'hello\n' > ${join(dirOther, "outside.txt")}`, async () => {
  await writeFile(join(dirOther, "outside.txt"), "hello\n", "utf-8")
})
check(
  "s8: created file in another repo is tracked (absolute path)",
  ctx6.panel()?.join("\n").includes(`created  ${join(dirOther, "outside.txt")} +1/-0`) === true,
)

// 8b: modify a pre-dirty file in another repo: +1/-0 vs pre-call content, not +2/-0 vs its HEAD.
await bash(pi6, ctx6, "s8.2", `echo new >> ${join(dirOther, "other-committed.txt")}`, async () => {
  await writeFile(join(dirOther, "other-committed.txt"), "base\ndirty\nnew\n", "utf-8")
})
check(
  "s8: counts vs pre-call content, not the other repo's HEAD",
  ctx6.panel()?.join("\n").includes(`modified ${join(dirOther, "other-committed.txt")} +1/-0`) === true,
)

// 8c: relative path after `cd` into a non-repo dir (virtual cwd).
await bash(pi6, ctx6, "s8.3", `cd ${dirNoRepo} && echo hi > plain.txt`, async () => {
  await writeFile(join(dirNoRepo, "plain.txt"), "hi\n", "utf-8")
})
check(
  "s8: relative path after cd into a non-repo dir is tracked",
  ctx6.panel()?.join("\n").includes(`created  ${join(dirNoRepo, "plain.txt")} +1/-0`) === true,
)

// 8d: a command that only reads an outside file tracks nothing new.
await bash(pi6, ctx6, "s8.4", `cat ${join(dirOther, "outside.txt")}`, async () => {})
check("s8: read-only command tracks nothing", ctx6.panel()?.[0] === "│ Session changes: 3 files  +3/-0  ·  3 this prompt")

// 8e: deleting an outside created file reverts it off the set.
await bash(pi6, ctx6, "s8.5", `rm ${join(dirNoRepo, "plain.txt")}`, async () => {
  await rm(join(dirNoRepo, "plain.txt"))
})
check(
  "s8: deleting an outside created file reverts it",
  ctx6.panel()?.[0] === "│ Session changes: 2 files  +2/-0  ·  2 this prompt" && !ctx6.panel()?.join("\n").includes("plain.txt"),
)

// 8f: an in-repo file named in the command is tracked once, not duplicated by the git diff.
await bash(pi6, ctx6, "s8.6", "echo z > sniff-inrepo.txt", async () => {
  await writeFile(join(dir, "sniff-inrepo.txt"), "z\n", "utf-8")
})
const s8rows = (ctx6.panel() ?? []).filter((l) => l.includes("sniff-inrepo.txt"))
check(
  "s8: in-repo sniffed file appears exactly once",
  s8rows.length === 1 && s8rows[0].startsWith("│ created  sniff-inrepo.txt +1/-0"),
)

// --- Scenario 9: external edits after a reconcile are not attributed (parallel-session leak) ---
// A file that reconciles to its Original must be forgotten entirely. Otherwise
// the settle sweep re-scans it forever and hoists edits made by a parallel pi
// session or another terminal into this session's set.
const dir9 = await fixture("fc-ext-")
await execFileAsync("git", ["init"], { cwd: dir9 })
await writeFile(join(dir9, "file.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dir9 })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir9 })

const pi7 = new MockPi()
const ctx7 = new MockCtx(dir9)
await ext(pi7 as any)

// 9a: a bash call that commits a dirty file reconciles it to HEAD content.
await writeFile(join(dir9, "file.txt"), "base\ndirty\n", "utf-8") // pre-call dirt
await bash(pi7, ctx7, "s9.1", "git add . && git commit -m snap", async () => {
  await execFileAsync("git", ["add", "."], { cwd: dir9 })
  await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "snap"], { cwd: dir9 })
})
check("s9: committed file reconciles to nothing", ctx7.panel() === undefined)
await fire(pi7, "agent_settled", {}, ctx7)
// A parallel session (no tool events here) edits the committed file. A legit
// change then makes the next settle run the sweep over remaining Originals.
await writeFile(join(dir9, "file.txt"), "base\nexternal\n", "utf-8")
await editFile(pi7, ctx7, "s9.2", "other.txt", "x\n")
await fire(pi7, "agent_settled", {}, ctx7)
const s9panel = ctx7.panel()?.join("\n") ?? ""
check(
  "s9: external edit to reconciled file not attributed",
  !s9panel.includes("file.txt") && s9panel.includes("created  other.txt +1/-0"),
)

// 9b: same leak via Revert: a reverted file must forget its Original too.
await editFile(pi7, ctx7, "s9.3", "tmp.txt", "a\n") // created, in set
await editFile(pi7, ctx7, "s9.4", "tmp.txt", null) // deleted again: Revert
await writeFile(join(dir9, "tmp.txt"), "external\n", "utf-8") // parallel session recreates it
await fire(pi7, "agent_settled", {}, ctx7)
check("s9: external recreate after revert not attributed", !(ctx7.panel()?.join("\n") ?? "").includes("tmp.txt"))

// --- Scenario 10: accidental prompts keep cumulative rows, reset only activity ---
const dir10 = await fixture("fc-prompt-")
const pi8 = new MockPi()
const ctx8 = new MockCtx(dir10)
await ext(pi8 as any)
await editFile(pi8, ctx8, "r1", "one.txt", "1\n")
await editFile(pi8, ctx8, "r2", "two.txt", "2\n")
check("s10: both initial edits carry activity tags", ctx8.panel()?.join("\n") ===
  `│ Session changes: 2 files  +2/-0  ·  2 this prompt\n│ created  two.txt +1/-0  this prompt\n│ created  one.txt +1/-0  this prompt`)

const initialPanel = ctx8.panel()?.join("\n")
await fire(pi8, "agent_start", {}, ctx8)
await fire(pi8, "before_agent_start", { messageType: "custom", message: { customType: "test", content: "retry" } }, ctx8)
check("s10: low-level and custom starts preserve activity", ctx8.panel()?.join("\n") === initialPanel)
await fire(pi8, "before_agent_start", { messageType: "user", prompt: "oops", images: [] }, ctx8)
check("s10: accidental user prompt keeps both rows and totals", ctx8.panel()?.join("\n") ===
  `│ Session changes: 2 files  +2/-0\n│ created  two.txt +1/-0\n│ created  one.txt +1/-0`)
check("s10: user prompt resets activity flags only", getSharedFileChangesTracker(pi8 as any, ctx8 as any).getChanges().every((item) => !item.touchedThisPrompt))

await editFile(pi8, ctx8, "r3", "three.txt", "3\n")
check("s10: new edit joins cumulative rows with one active row", ctx8.panel()?.join("\n") ===
  `│ Session changes: 3 files  +3/-0  ·  1 this prompt\n│ created  three.txt +1/-0  this prompt\n│ created  two.txt +1/-0\n│ created  one.txt +1/-0`)
const tracker8 = getSharedFileChangesTracker(pi8 as any, ctx8 as any)
check("s10: tracker exposes cumulative readonly-shaped changes", tracker8.getChanges().length === 3 && tracker8.getChanges().filter((item) => item.touchedThisPrompt).map((item) => item.path).join() === "three.txt")
check("s10: obsolete mode command is not registered", !("filechanges-mode" in pi8.commands))

ctx8.notifications = []
await pi8.commands["filechanges"].handler("", ctx8)
check("s10: requested List shows all cumulative files", ["one.txt", "two.txt", "three.txt"].every((path) => ctx8.listLines.some((line) => line.includes(path))) && ctx8.notifications.length === 0)
const listCount = ctx8.listCount
for (const args of ["all", "round", "unexpected argument"]) {
  ctx8.notifications = []
  await pi8.commands["filechanges"].handler(args, ctx8)
  check(`s10: /filechanges ${args} shows usage, not a view`, ctx8.notifications[0]?.startsWith("Usage: /filechanges (no arguments)") === true && ctx8.listCount === listCount)
}
ctx8.notifications = []
await pi8.commands["filechanges-clear"].handler("all", ctx8)
check("s10: Clear rejects arguments without clearing", ctx8.notifications[0]?.startsWith("Usage: /filechanges-clear (no arguments)") === true && tracker8.getChanges().length === 3)

await fire(pi8, "agent_settled", {}, ctx8)
const persistedActivity = pi8.latestSessionSetEntry()
const pi9 = new MockPi()
const ctx9 = new MockCtx(dir10)
ctx9.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: persistedActivity }]
await ext(pi9 as any)
await fire(pi9, "session_start", {}, ctx9)
check("s10: reload keeps cumulative counts and activity markers", ctx9.panel()?.join("\n") === ctx8.panel()?.join("\n"))

const piLegacy = new MockPi()
const ctxLegacy = new MockCtx(dir10)
// Old round/mode values must not hide rows, even when the old view was empty.
ctxLegacy.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: { ...persistedActivity, mode: "round", round: [] } }]
await ext(piLegacy as any)
await fire(piLegacy, "session_start", {}, ctxLegacy)
check("s10: legacy mode is ignored, all rows remain visible", getSharedFileChangesTracker(piLegacy as any, ctxLegacy as any).getChanges().length === 3 && ctxLegacy.panel()?.[0]?.startsWith("│ Session changes: 3 files") === true)

await fire(pi9, "before_agent_start", { messageType: "user", prompt: "another accidental prompt", images: [] }, ctx9)
check("s10: restored activity resets without hiding session rows", ctx9.panel()?.length === 4 && !(ctx9.panel()?.join("\n") ?? "").includes("this prompt"))
await fire(pi9, "agent_settled", {}, ctx9)
const piReset = new MockPi()
const ctxReset = new MockCtx(dir10)
ctxReset.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: pi9.latestSessionSetEntry() }]
await ext(piReset as any)
await fire(piReset, "session_start", {}, ctxReset)
check("s10: reset activity markers persist across reload", ctxReset.panel()?.length === 4 && !(ctxReset.panel()?.join("\n") ?? "").includes("this prompt"))
await pi9.commands["filechanges-clear"].handler("", ctx9)
check("s10: Clear removes rows and persists empty state", ctx9.panel() === undefined && pi9.latestSessionSetEntry()?.items?.length === 0)
await editFile(pi9, ctx9, "r4", "one.txt", "1\nnext\n")
check("s10: Clear forgets originals and restarts activity", ctx9.panel()?.join("\n") ===
  `│ Session changes: 1 file  +1/-0  ·  1 this prompt\n│ modified one.txt +1/-0  this prompt`)

// --- Scenario 11: semantic colors (recording theme) ---
const dirC = await fixture("fc-color-")
const piC = new MockPi()
const ctxC = new MockCtx(dirC, { colorize: true })
await ext(piC as any)

await writeFile(join(dirC, "existing.txt"), "old\n", "utf-8")
await writeFile(join(dirC, "gone.txt"), "gone\n", "utf-8")
await editFile(piC, ctxC, "c1", "new.txt", "x\n") // created (+1/-0)
await editFile(piC, ctxC, "c2", "existing.txt", "new\n") // modified (+1/-1)
await editFile(piC, ctxC, "c3", "gone.txt", null) // deleted (+0/-1)

ctxC.foregrounds = []; ctxC.boldTexts = []
const colorPanel = (ctxC.panel() ?? []).join("\n")
check("s11: header is bold and carries semantic diff totals", ctxC.boldTexts.includes("Session changes: 3 files") && ctxC.colored("toolDiffAdded", "+2") && ctxC.colored("toolDiffRemoved", "-2"))
check("s11: each kind has its semantic color", ctxC.colored("error", "deleted") && ctxC.colored("warning", "modified") && ctxC.colored("success", "created"))
check("s11: paths use text, zeros dim, activity muted", ["gone.txt", "existing.txt", "new.txt"].every((path) => ctxC.colored("text", path)) && ctxC.colored("dim", "+0") && ctxC.colored("dim", "-0") && ctxC.colored("muted", "this prompt"))
check("s11: numeric row counts have no parentheses", colorPanel.includes("gone.txt +0/-1") && !/\([+-]\d/.test(colorPanel))
ctxC.foregrounds = []; ctxC.boldTexts = []; ctxC.notifications = []
await piC.commands["filechanges"].handler("", ctxC)
check("s11: requested List uses semantic colors too", ctxC.listLines[0].startsWith("Session changes: 3 files") && ctxC.colored("warning", "modified") && ctxC.colored("toolDiffRemoved", "-1") && ctxC.notifications.length === 0)

// --- Scenario 12: Repo state annotation ---
const dirS = await fixture("fc-state-")
await execFileAsync("git", ["init"], { cwd: dirS })
await writeFile(join(dirS, "tracked.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dirS })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dirS })

const piS = new MockPi()
const ctxS = new MockCtx(dirS)
await ext(piS as any)

// 12a: edit/write results are not a refresh point; the settle annotates the dirty row.
await editFile(piS, ctxS, "st1", "tracked.txt", "base\nedit\n")
check(
  "s12: row carries no state before a refresh point",
  ctxS.panel()?.join("\n") === `│ Session changes: 1 file  +1/-0  ·  1 this prompt\n│ modified tracked.txt +1/-0  this prompt`,
)
await fire(piS, "agent_settled", {}, ctxS)
check(
  "s12: settle annotates a dirty tracked file as unstaged",
  ctxS.panel()?.join("\n") === `│ Session changes: 1 file  +1/-0  ·  1 this prompt\n│ modified tracked.txt +1/-0 unstaged  this prompt`,
)

// 12b: `git add` changes only the index (porcelain path set unchanged); the bash result still flips the word.
await bash(piS, ctxS, "st2", "git add tracked.txt", async () => {
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: dirS })
})
check("s12: bash git add flips to staged", ctxS.panel()?.join("\n").includes("tracked.txt +1/-0 staged") === true)

// 12c: `git commit` clears the porcelain entry; the row stays (counts are vs the Original) and reads committed.
await bash(piS, ctxS, "st3", "git commit -m snap", async () => {
  await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "snap"], { cwd: dirS })
})
check(
  "s12: bash git commit flips to committed, row stays",
  ctxS.panel()?.join("\n").includes("modified tracked.txt +1/-0 committed") === true,
)

// 12d: a created file is untracked.
await editFile(piS, ctxS, "st4", "new.txt", "n\n")
await fire(piS, "agent_settled", {}, ctxS)
check("s12: created file is untracked", ctxS.panel()?.join("\n").includes("created  new.txt +1/-0 untracked") === true)

// 12e: outside staging stays stale across prompt boundaries, until /filechanges.
await execFileAsync("git", ["add", "new.txt"], { cwd: dirS })
check("s12: external stage is stale until a refresh point", ctxS.panel()?.join("\n").includes("new.txt +1/-0 untracked") === true)
await fire(piS, "before_agent_start", { messageType: "user", prompt: "oops", images: [] }, ctxS)
await fire(piS, "agent_start", {}, ctxS)
check("s12: prompt boundaries do not refresh Git state", ctxS.panel()?.join("\n").includes("new.txt +1/-0 untracked") === true && !(ctxS.panel()?.join("\n") ?? "").includes("this prompt"))
await piS.commands["filechanges"].handler("", ctxS)
check("s12: manual /filechanges picks up external staging", ctxS.panel()?.join("\n").includes("new.txt +1/-0 staged") === true && ctxS.listLines.some((line) => line.includes("new.txt +1/-0 staged")))

// 12f: a file outside any repo gets no state word.
const dirS2 = await fixture("fc-stateplain-")
await fire(piS, "tool_call", { toolName: "write", input: { path: join(dirS2, "plain.txt") }, toolCallId: "st5" }, ctxS)
await writeFile(join(dirS2, "plain.txt"), "p\n", "utf-8")
await fire(piS, "tool_result", { toolName: "write", toolCallId: "st5", isError: false }, ctxS)
await fire(piS, "agent_settled", {}, ctxS)
check(
  "s12: non-repo file carries no state word",
  (ctxS.panel() ?? []).find((l) => l.includes("plain.txt")) === `│ created  ${join(dirS2, "plain.txt")} +1/-0  this prompt`,
)

// 12g: states are not persisted; restore recomputes them from git and colors them by meaning.
const piSC = new MockPi()
const ctxSC = new MockCtx(dirS, { colorize: true })
ctxSC.branchEntries = [{ type: "custom", customType: "filechanges:session-set", data: piS.latestSessionSetEntry() }]
await ext(piSC as any)
await fire(piSC, "session_start", {}, ctxSC)
const stateColorPanel = (ctxSC.panel() ?? []).join("\n")
check("s12: restore recomputes state words, colored by meaning", stateColorPanel.includes("committed") && stateColorPanel.includes("staged") && ctxSC.colored("dim", "committed") && ctxSC.colored("accent", "staged"))
check("s12: persisted items omit display-only Repo state", piS.latestSessionSetEntry()?.items.every((item: any) => !("repoState" in item)) === true)
const plainStateLine = (ctxSC.panel() ?? []).find((l) => l.includes("plain.txt")) ?? ""
check(
  "s12: restored non-repo row has no state markup",
  plainStateLine.includes("plain.txt") && !/(untracked|staged|committed)/.test(plainStateLine),
)

// A post-restore edit re-dirties the committed file: unstaged renders muted (never warning yellow).
await editFile(piSC, ctxSC, "st6", "tracked.txt", "base\nedit\nagain\n")
await fire(piSC, "agent_settled", {}, ctxSC)
ctxSC.panel()
check("s12: unstaged renders muted, not warning", ctxSC.colored("muted", "unstaged") && !ctxSC.colored("warning", "unstaged"))

// --- Scenario 13: tmp files are filtered out at every entry point ---
// The seam points at tmpExcluded (set at the top). A second root inside the
// cwd repo exercises the git-diff entry point too: files under it are
// visible to `git status` but must still be filtered.
const dir13 = await fixture("fc-tmpfilter-")
await execFileAsync("git", ["init"], { cwd: dir13 })
await writeFile(join(dir13, "keep.txt"), "base\n", "utf-8")
await execFileAsync("git", ["add", "."], { cwd: dir13 })
await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir13 })
const tmpRoot = join(dir13, "tmp-excluded")
await mkdir(tmpRoot)
__setTmpRootsForTest([tmpExcluded, tmpRoot])

const pi13 = new MockPi()
const ctx13 = new MockCtx(dir13)
await ext(pi13 as any)

// 13a: a write tool call to a file in the tmp root tracks nothing.
const tmpWrite = join(tmpRoot, "w.txt")
await fire(pi13, "tool_call", { toolName: "write", input: { path: tmpWrite }, toolCallId: "t13a" }, ctx13)
await writeFile(tmpWrite, "x\n", "utf-8")
await fire(pi13, "tool_result", { toolName: "write", toolCallId: "t13a", isError: false }, ctx13)
check("s13: write to tmp path not tracked", ctx13.panel() === undefined)

// 13b: a bash call that modifies a sniffed candidate in the tmp root tracks
// nothing, neither via the sniff nor via the git diff (the tmp root is a
// subdir of the cwd repo, so git status sees it too).
const tmpBash = join(tmpRoot, "b.txt")
await bash(pi13, ctx13, "t13b", `printf 'y\n' > ${tmpBash}`, async () => {
  await writeFile(tmpBash, "y\n", "utf-8")
})
check("s13: bash-written tmp file not tracked (sniff and git diff)", ctx13.panel() === undefined)

// 13c: editor temp names (*.tmp, *.swp, ...) inside the repo are ignored via the pattern list.
await bash(pi13, ctx13, "t13c", "echo swap > notes.tmp", async () => {
  await writeFile(join(dir13, "notes.tmp"), "swap\n", "utf-8")
})
check("s13: bash-written *.tmp file not tracked", !(ctx13.panel() ?? []).some((l) => l.includes("notes.tmp")))
await editFile(pi13, ctx13, "t13c2", "other.swp", "s\n")
check("s13: written *.swp file not tracked", !(ctx13.panel() ?? []).some((l) => l.includes("other.swp")))

// 13d: normal files in the same repo are still tracked (no over-filtering).
await editFile(pi13, ctx13, "t13d", "normal.txt", "n\n")
check("s13: normal file still tracked", (ctx13.panel()?.join("\n") ?? "").includes("created  normal.txt +1/-0"))

// 13e: restored persisted entries with a tmp absPath are dropped by sanitizeRestored.
const pi13b = new MockPi()
const ctx13b = new MockCtx(dir13)
ctx13b.branchEntries = [
  {
    type: "custom",
    customType: "filechanges:session-set",
    data: {
      items: [
        { path: "normal.txt", absPath: join(dir13, "normal.txt"), kind: "created", added: 1, removed: 0, binary: false, updatedAt: 1 },
        { path: "w.txt", absPath: tmpWrite, kind: "created", added: 1, removed: 0, binary: false, updatedAt: 2 },
      ],
    },
  },
]
await ext(pi13b as any)
await fire(pi13b, "session_start", {}, ctx13b)
const s13ePanel = ctx13b.panel()?.join("\n") ?? ""
check(
  "s13: restore drops tmp entries, keeps normal ones",
  s13ePanel.includes("normal.txt") && !s13ePanel.includes("w.txt"),
)

// 13f: a bash call modifying a file under the outer fixture root (outside
// any repo, pure sniff path) also tracks nothing.
const tmpOuter = join(tmpExcluded, "outer.txt")
await bash(pi13, ctx13, "t13f", `printf 'z\n' > ${tmpOuter}`, async () => {
  await writeFile(tmpOuter, "z\n", "utf-8")
})
check(
  "s13: bash-written file under outer tmp root not tracked",
  !(ctx13.panel()?.join("\n") ?? "").includes("outer.txt"),
)

} finally {
  __setTmpRootsForTest(null)
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
