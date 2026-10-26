// Exercise the real Panel and List without Git, disk snapshots, or a model.
import { FileChangesPanel, FileChangesList, displayPath, shortenPath, formatPanelRow } from "../pi/.pi/agent/extensions/filechanges.ts"
import type { FileChange } from "../pi/.pi/agent/extensions/filechanges-tracker.ts"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import type { Theme } from "@earendil-works/pi-coding-agent"

let failures = 0
let checks = 0
function check(name: string, condition: boolean) {
  checks++
  if (condition) console.log(`ok   ${name}`)
  else { failures++; console.log(`FAIL ${name}`) }
}

function item(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, absPath: `/fixture/${path}`, absolutePath: `/fixture/${path}`, kind: "modified", added: 3,
    removed: 2, binary: false, updatedAt: 1, touchedThisPrompt: true, ...overrides }
}
const plainTheme = { colors: {}, fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme
function host(rows = 24) {
  const state = { renders: 0, closed: 0 }
  return { state, tui: { terminal: { rows }, requestRender: () => state.renders++ },
    keybindings: { matches: (_data: string, _action: string) => false }, done: () => state.closed++ }
}
function list(items: readonly FileChange[], rows = 24, theme = plainTheme) {
  const h = host(rows)
  return { ...h, component: new FileChangesList(items, theme, h.tui, h.keybindings, h.done) }
}
function fits(lines: string[], width: number): boolean {
  return lines.every((line) => visibleWidth(line) <= width && !/[\n\r\t\x00\x07]/.test(line))
}

const hostile = "src/\x1b[31mred\x1b[0m/\x1b]0;injected title\x07路径\ncontrol\r\t\x00\x07\x7f\x85.txt"
const paths = [
  "packages/very/long/nested/directory/component-file.ts",
  "src/目录/界面😀/cafe\u0301-最後.ts",
  hostile,
  "src/" + "nested/".repeat(30) + "recognizable-basename-tail.ts",
]
const changes = paths.map((path, i) => item(path, { kind: i === 0 ? "created" : i === 2 ? "deleted" : "modified",
  repoState: i === 0 ? "staged" : i === 1 ? "conflicted" : "unstaged" }))

const widths = [0, 1, 20, 40, 80, 120]
for (const width of widths) {
  const panel = new FileChangesPanel(changes, plainTheme)
  let lines: string[] = []
  try { lines = panel.render(width); check(`Panel render does not throw at width ${width}`, true) }
  catch { check(`Panel render does not throw at width ${width}`, false); continue }
  check(`Panel fits width ${width} with Unicode and control paths`, fits(lines, width))
  check(`Panel stays within eight rows at width ${width}`, lines.length <= 8)
  check(`Panel has no injectable terminal controls at width ${width}`, lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))))
  check(`Panel caches line-array identity at width ${width}`, panel.render(width) === lines)

  const requested = list(changes)
  try {
    const output = requested.component.render(width)
    check(`List fits width ${width} with Unicode and control paths`, fits(output, width))
  } catch { check(`List fits width ${width} with Unicode and control paths`, false) }
}
check("displayPath removes CSI and OSC injection", !displayPath(hostile).includes("\x1b") && !displayPath(hostile).includes("injected title"))
check("displayPath escapes controls on one line", displayPath(hostile).includes("\\n") && displayPath(hostile).includes("\\r") && displayPath(hostile).includes("\\t") && !/[\x00-\x1f\x7f-\x9f]/.test(displayPath(hostile)))
check("displayPath preserves Unicode and combining characters", displayPath(paths[1]) === paths[1])
check("shortenPath handles zero and one column", shortenPath(paths[0], 0) === "" && shortenPath(paths[0], 1) === "…")
check("shortenPath keeps the complete basename when it fits", shortenPath(paths[3], 40).startsWith("…") && shortenPath(paths[3], 40).endsWith("recognizable-basename-tail.ts"))
check("shortenPath retains the basename tail in tiny budgets", shortenPath(paths[3], 10) === "…" + paths[3].slice(-9) && visibleWidth(shortenPath(paths[3], 10)) <= 10)
const tailRow = formatPanelRow(item(paths[3]), 60, plainTheme)
check("Panel reserves counts and keeps basename tail", tailRow.includes("recognizable-basename-tail.ts") && tailRow.includes("+3/-2") && tailRow.includes("…"))
check("conflicted metadata survives before normal activity", formatPanelRow(item("file.ts", { repoState: "conflicted" }), 40, plainTheme).includes("conflicted"))

const six = Array.from({ length: 6 }, (_, i) => item(`file-${i}.ts`))
const full = new FileChangesPanel(six, plainTheme).render(120)
check("six files fit without an overflow hint", full.length === 7 && full.slice(1).every((line, i) => line.includes(`file-${i}.ts`)))
const eight = Array.from({ length: 8 }, (_, i) => item(`file-${i}.ts`))
const cap = new FileChangesPanel(eight, plainTheme).render(120)
check("Panel caps at six file rows and eight total lines", cap.length === 8 && cap.slice(1, 7).every((line, i) => line.includes(`file-${i}.ts`)))
check("Panel overflow shows the remaining count and List command", cap[7].includes("2 more") && cap[7].includes("/filechanges"))
check("empty Panel has no rows", new FileChangesPanel([], plainTheme).render(80).length === 0)
const mixed = [item("binary.dat", { binary: true, added: 100, removed: 100 }), item("text.txt", { added: 2, removed: 1, touchedThisPrompt: false })]
const totals = new FileChangesPanel(mixed, plainTheme).render(120)
check("summary counts files and excludes binary diff totals", totals[0].includes("2 files") && totals[0].includes("+2/-1") && totals[0].includes("1 this prompt"))
check("binary row uses binary metadata, not numeric deltas", totals[1].includes("(binary)") && !totals[1].includes("+100"))

// Pi keeps a stable theme Proxy while replacing its concrete colors object.
let palette = { name: "first", ansi: "\x1b[31m" }
let backgrounds = 0
const paletteCalls: string[] = []
const proxyTheme = new Proxy({} as Theme, {
  get: (_target, prop) => {
    if (prop === "colors") return palette
    if (prop === "fg") return (_color: string, text: string) => { paletteCalls.push(palette.name); return palette.ansi + text + "\x1b[39m" }
    if (prop === "bold") return (text: string) => "\x1b[1m" + text + "\x1b[22m"
    if (prop === "bg") return (_color: string, text: string) => { backgrounds++; return "\x1b[41m" + text + "\x1b[49m" }
    return undefined
  },
})
const cached = new FileChangesPanel(six, proxyTheme)
const first = cached.render(80)
const calls = paletteCalls.length
check("cached Panel returns the same lines without theme work", cached.render(80) === first && paletteCalls.length === calls)
check("setItems with identical items preserves cached lines", !cached.setItems(six) && cached.render(80) === first)
const resized = cached.render(40)
check("resize makes fresh width-bounded cached lines", resized !== first && fits(resized, 40) && cached.render(40) === resized)
const changed = [...six, item("newest.ts")]
check("new item-array identity invalidates cache", cached.setItems(changed) && cached.render(40) !== resized)
const beforeTheme = cached.render(80)
palette = { name: "second", ansi: "\x1b[32m" }
const afterTheme = cached.render(80)
check("stable theme Proxy refreshes colors and cached lines", afterTheme !== beforeTheme && afterTheme.some((line) => line.includes("\x1b[32m")) && afterTheme.every((line) => !line.includes("\x1b[31m")))
check("theme update keeps plain text intact", stripTerminalSequences(afterTheme.join("\n")) === stripTerminalSequences(beforeTheme.join("\n")))
cached.invalidate()
check("unrelated Pi invalidation preserves unchanged immutable cached rows", cached.render(80) === afterTheme)
check("Panel never applies a background color", backgrounds === 0 && first.concat(afterTheme).every((line) => !/\x1b\[(?:4[0-9]|48);?/.test(line)))

const themedList = list([item("theme-sensitive.ts")], 24, proxyTheme)
const listBefore = themedList.component.render(120)
palette = { name: "third", ansi: "\x1b[34m" }
themedList.component.invalidate()
const listAfter = themedList.component.render(120)
check("List invalidation reads current Proxy colors for rows", listAfter[1]?.includes("\x1b[34m") === true && !listAfter[1]?.includes("\x1b[32m"))
check("List theme update keeps plain text intact", stripTerminalSequences(listBefore.join("\n")) === stripTerminalSequences(listAfter.join("\n")))

const many = Array.from({ length: 200 }, (_, i) => item(`full/path/file-${String(i + 1).padStart(3, "0")}.ts`, { touchedThisPrompt: false }))
const oldTimeout = globalThis.setTimeout
const oldInterval = globalThis.setInterval
let timers = 0
try {
  globalThis.setTimeout = ((..._args: any[]) => { timers++; throw new Error("unexpected scrollbar timeout") }) as any
  globalThis.setInterval = ((..._args: any[]) => { timers++; throw new Error("unexpected scrollbar interval") }) as any
  const scroll = list(many)
  const start = scroll.component.render(120)
  check("200-file List starts at the first row, not the last", start[1]?.includes("file-001.ts") === true && !start.join("\n").includes("file-200.ts"))
  check("List viewport is bounded by terminal rows", start.length === 18)
  scroll.component.handleInput("\x1b[F") // End
  const end = scroll.component.render(120)
  check("End reaches the final row of all 200 files", end.some((line) => line.includes("file-200.ts")) && end.at(-1)?.includes("/200 lines") === true)
  scroll.component.handleInput("\x1b[H") // Home
  check("Home returns to the first row", scroll.component.render(120)[1]?.includes("file-001.ts") === true)
  scroll.component.handleInput("\x1b[6~") // PageDown
  check("PageDown advances by the viewport", scroll.component.render(120)[1]?.includes("file-017.ts") === true)
  scroll.component.handleInput("\x1b[5~") // PageUp
  check("PageUp returns by the viewport", scroll.component.render(120)[1]?.includes("file-001.ts") === true)
  for (let i = 0; i < 20; i++) scroll.component.handleInput("\x1b[6~")
  check("bounded PageDown sequence reaches final file", scroll.component.render(120).some((line) => line.includes("file-200.ts")))
  const renderCount = scroll.state.renders
  scroll.component.handleInput("unhandled")
  check("unhandled input does not request a render", scroll.state.renders === renderCount)
  scroll.component.handleInput("\x1b") // Escape
  check("Escape closes the full List", scroll.state.closed === 1)
  check("scrolling requests renders", scroll.state.renders > 0)
  check("hidden scrollbar does not schedule timers", timers === 0)
} finally {
  globalThis.setTimeout = oldTimeout
  globalThis.setInterval = oldInterval
}
const cachedResize = list(many, 24)
cachedResize.component.render(120)
cachedResize.component.handleInput("\x1b[B")
check("Down scrolls one line", cachedResize.component.render(120)[1]?.includes("file-002.ts") === true)
cachedResize.component.handleInput("\x1b[A")
check("Up scrolls one line", cachedResize.component.render(120)[1]?.includes("file-001.ts") === true)
cachedResize.tui.terminal.rows = 12
check("List adapts viewport height on resize", cachedResize.component.render(80).length === 6)
const all = list(many, 208).component.render(120)
check("full List is not truncated at 30 files", all.length === 202 && many.every((change) => all.some((line) => line.includes(change.path))))
check("full List retains complete paths and reaches row 200", all[31].includes(many[30].path) && all[200].includes(many[199].path) && !all.join("\n").includes("more · /filechanges"))
const wrappedPath = "deep/".repeat(25) + "final-name.ts"
const wrapped = list([item(wrappedPath)], 208).component.render(20)
check("List wraps full paths instead of shortening them", fits(wrapped, 20) && wrapped.slice(1, -1).join("").includes(wrappedPath) && !wrapped.slice(1, -1).join("").includes("…"))
const customKeys = host()
customKeys.keybindings.matches = (data: string, action: string) => data === "cancel-custom" && action === "tui.select.cancel"
const custom = new FileChangesList(many, plainTheme, customKeys.tui, customKeys.keybindings, customKeys.done)
custom.render(80)
custom.handleInput("cancel-custom")
check("List honors configured cancel keybindings", customKeys.state.closed === 1)
const pageKeys = host()
pageKeys.keybindings.matches = (data: string, action: string) => data === "page-custom" && action === "tui.select.pageDown"
const paging = new FileChangesList(many, plainTheme, pageKeys.tui, pageKeys.keybindings, pageKeys.done)
paging.render(80)
paging.handleInput("page-custom")
check("List honors configured page keybindings", paging.render(80)[1]?.includes("file-017.ts") === true)
const ctrl = list(many)
ctrl.component.handleInput("\x03")
check("Ctrl+C also closes the List", ctrl.state.closed === 1)
console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES (${checks} checks)`)
process.exitCode = failures === 0 ? 0 : 1
