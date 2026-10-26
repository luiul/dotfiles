// Unit tests for the zen v2 extension (one-line compact tool calls,
// pi/.pi/agent/extensions/zen.ts):
// - loadFilterOn/saveFilterOn: strict typing (garbage JSON never flips the
//   mode), default ON, roundtrip, via the module's test seam.
// - Pure formatting helpers: stripAnsi/visibleWidth, truncateVisible,
//   formatDuration, firstTextLine, infoFromResult, infoChanged, suffixFor,
//   condenseArgs, compactCallText, NATIVE_ONE_LINE_TOOLS membership.
// - makeResolver: off returns next() unchanged; on wraps native renderers;
//   definitions without renderCall get generic renderers.
// - Wrapper behavior against FAKE native renderers: compact one-line call
//   (decorated suffix), collapsed success renders zero rows, error text
//   lands on the call line, the deferred invalidate fires exactly once
//   (two-pass termination), off/expanded/partial delegate to native, and
//   native throws fall back (fail-open), never returning undefined.
// - Registry: renderers remember per-block invalidate closures; the
//   session_start/session_tree/compaction handlers clear them.
//
// Run: bun scripts/test-zen-extension.ts
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "zen-v2-"));

const M = await import("../pi/.pi/agent/extensions/zen.ts");
const {
	loadFilterOn,
	saveFilterOn,
	__setConfigPathForTest,
	__registrySizeForTest,
	stripAnsi,
	visibleWidth,
	truncateVisible,
	formatDuration,
	firstTextLine,
	infoFromResult,
	infoChanged,
	suffixFor,
	condenseArgs,
	compactCallText,
	NATIVE_ONE_LINE_TOOLS,
	singleLine,
	makeResolver,
} = M;

__setConfigPathForTest(join(TMP, "zen.json"));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A minimal fake theme with realistic SGR escapes, so stripAnsi works.
const theme = {
	fg: (name: string, text: string) => `\x1b[38;5;${name.length + 240}m${text}\x1b[0m`,
	bg: (name: string, text: string) => `\x1b[48;5;${name.length + 240}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

// ─── config ───────────────────────────────────────────────────────────────────

console.log("config");
check("default on", loadFilterOn() === true);
writeFileSync(join(TMP, "zen.json"), JSON.stringify({ filter: false }));
check("saved off reads off", loadFilterOn() === false);
writeFileSync(join(TMP, "zen.json"), JSON.stringify({ filter: "yes" }));
check("garbage type reads default", loadFilterOn() === true);
writeFileSync(join(TMP, "zen.json"), "{ broken json");
check("broken json reads default", loadFilterOn() === true);
check("saveFilterOn roundtrip", saveFilterOn(false) === true && loadFilterOn() === false);

// ─── formatting helpers ──────────────────────────────────────────────────────

console.log("formatting helpers");
check("stripAnsi removes escapes", stripAnsi("\x1b[1mplain\x1b[0m") === "plain");
check("visibleWidth counts terminal columns", visibleWidth("日本語") === 6);
check("visibleWidth strips ansi", visibleWidth(`\x1b[1m${"x".repeat(10)}\x1b[0m`) === 10);
check("truncateVisible keeps short", truncateVisible("abc", 10) === "abc");
check("truncateVisible cuts long", stripAnsi(truncateVisible("abcdef", 4)) === "abc…");
check("truncateVisible budget 1", stripAnsi(truncateVisible("abc", 1)) === "…");
check("formatDuration undefined", formatDuration(undefined) === "");
check("formatDuration ms", formatDuration(42) === "42ms");
check("formatDuration seconds", formatDuration(4200) === "4.2s");
check("firstTextLine empty", firstTextLine([]) === "");
check("firstTextLine skips blanks", firstTextLine([{ type: "text", text: "\n  \ncat: nope" }]) === "cat: nope");
check(
	"firstTextLine walks blocks",
	firstTextLine([{ type: "image", data: "x" }, { type: "text", text: "second block line" }]) ===
		"second block line",
);

const okInfo = infoFromResult({ content: [{ type: "text", text: "done" }] }, { isError: false, durationMs: 421 });
check("info success", okInfo.ok === true && okInfo.durationMs === 421 && okInfo.errLine === "");
const errInfo = infoFromResult(
	{ content: [{ type: "text", text: "cat: missing.txt: No such file or directory\nmore" }] },
	{ isError: true, durationMs: 2100 },
);
check("info error first line", errInfo.ok === false && errInfo.errLine === "cat: missing.txt: No such file or directory");
check("infoChanged undefined prev", infoChanged(undefined, okInfo) === true);
check("infoChanged same", infoChanged(okInfo, okInfo) === false);
check("infoChanged duration", infoChanged(okInfo, { ...okInfo, durationMs: 500 }) === true);
check("infoChanged errLine", infoChanged(okInfo, { ...okInfo, errLine: "x" }) === true);

check("suffix no info", suffixFor(undefined, theme) === "");
const okSuffix = suffixFor(okInfo, theme);
check("suffix success", stripAnsi(okSuffix) === " ✓ (0.4s)" && okSuffix.includes("38;5;"), okSuffix);
const noDur = suffixFor({ ok: true, durationMs: undefined, errLine: "" }, theme);
check("suffix success no duration", stripAnsi(noDur) === " ✓");
const errSuffix = suffixFor(errInfo, theme);
check(
	"suffix error",
	stripAnsi(errSuffix) === " ✗ cat: missing.txt: No such file or directory (2.1s)",
	errSuffix,
);
check("suffix error truncated", stripAnsi(
	suffixFor(
		infoFromResult({ content: [{ type: "text", text: "x".repeat(200) }] }, { isError: true, durationMs: 5 }),
		theme,
	),
).length < 215);

// ─── per-tool call lines ──────────────────────────────────────────────────────

console.log("per-tool call lines");
check("bash is one-line native", NATIVE_ONE_LINE_TOOLS.has("bash"));
check("read is one-line native", NATIVE_ONE_LINE_TOOLS.has("read"));
check("write is NOT one-line native", !NATIVE_ONE_LINE_TOOLS.has("write"));
check("edit is NOT one-line native", !NATIVE_ONE_LINE_TOOLS.has("edit"));
check("condenseArgs prefers command", condenseArgs({ command: "git status", timeout: 5 }) === "git status");
check("condenseArgs falls back to path", condenseArgs({ path: "/tmp/x" }) === "/tmp/x");
check("condenseArgs first string entry", condenseArgs({ alpha: "one", beta: "two" }) === "one");
check(
	"compactCallText truncates long args",
	// toolName + one space + the 60-char arg budget
	visibleWidth(compactCallText("weird", { weird: "y".repeat(100) }, theme)) <= "weird".length + 1 + 60,
);
check("write call line has size", stripAnsi(compactCallText("write", { file_path: "/a/b.ts", content: "x\ny\nz" }, theme)).includes("(3 lines)"));
check("edit call line has edits", stripAnsi(compactCallText("edit", { file_path: "/a/b.ts", edits: [{}, {}] }, theme)).includes("(2 edits)"));
check("generic call line condenses", stripAnsi(compactCallText("mcp__kb__search", { query: "hello" }, theme)).includes("hello"));

// ─── resolver ──────────────────────────────────────────────────────────────────

console.log("resolver");
const native = {
	renderCall(args: any, _t: any, ctx: any) {
		// A Text-like component pi's renderers would return: reused via
		// lastComponent, renderable at a width, padded to that width like
		// the real Text so width math in the decorator is exercised.
		const comp = (ctx?.lastComponent as any) ?? { tag: "native-call" };
		comp.render = (w: number) => [`$ ${args?.command ?? ""}`.slice(0, w).padEnd(w)];
		return comp;
	},
	renderResult(result: any, _o: any, _t: any, ctx: any) {
		const out = result?.content?.[0]?.text ?? "";
		const comp = (ctx?.lastComponent as any) ?? { tag: "native-result" };
		comp.render = (_w: number) => [out];
		return comp;
	},
};
const resolverOff = makeResolver(() => false);
check("off returns next() unchanged", resolverOff("bash", () => native) === native);
const resolverOn = makeResolver(() => true);
const wrapped = resolverOn("bash", () => native);
check("on wraps native", wrapped !== native && typeof wrapped.renderCall === "function");
const generic = resolverOn("mcp__kb__search", () => ({ execute: () => {} }));
check("definition without renderers gets generic", typeof generic.renderCall === "function");

// ─── wrapper behavior (fake native) ───────────────────────────────────────────

console.log("wrapper behavior");
let invalidateCalls = 0;
const mkCtx = (extra: Record<string, unknown> = {}) => ({
	state: {},
	lastComponent: undefined,
	invalidate() {
		invalidateCalls++;
	},
	expanded: false,
	isPartial: false,
	isError: false,
	durationMs: undefined,
	args: { command: "git status" },
	cwd: "/tmp",
	...extra,
});

// Compact success: collapsed result renders zero rows; suffix appears on the
// call line after the deferred invalidate (two-pass termination).
{
	invalidateCalls = 0;
	const ctx = mkCtx();
	const call = wrapped.renderCall({ command: "git status" }, theme, ctx);
	check("decorated component implements invalidate", typeof call.invalidate === "function");
	call.invalidate();
	const lines1 = call.render(80);
	const result = wrapped.renderResult(
		{ content: [{ type: "text", text: "On branch main" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: false, durationMs: 421 },
	);
	check("collapsed success zero result rows", (result?.render?.(80) ?? []).length === 0);
	check("no suffix before completion", !stripAnsi(lines1[0]).includes("✓"), lines1[0]);
	await sleep(10);
	check("deferred invalidate fired once", invalidateCalls === 1, invalidateCalls);
	// Pass 2: same component state, same final result → no new invalidate,
	// suffix now present on the call line.
	const call2 = wrapped.renderCall({ command: "git status" }, theme, ctx);
	const line2 = stripAnsi(call2.render(80)[0]);
	check("suffix on call line after pass 2", line2.includes("✓ (0.4s)"), line2);
	// The decorator renders the native line narrower so the suffix fits:
	// the total visible width must not exceed the requested width.
	const narrow = call2.render(12);
	check("suffix stays inside the requested width", visibleWidth(narrow[0]) <= 12 && stripAnsi(narrow[0]).includes("✓"), narrow[0]);
	await sleep(10);
	check("second identical pass schedules nothing", invalidateCalls === 1, invalidateCalls);
}

// Error: first error line lands on the call line.
{
	invalidateCalls = 0;
	const ctx = mkCtx();
	const call = wrapped.renderCall({ command: "cat missing.txt" }, theme, ctx);
	wrapped.renderResult(
		{ content: [{ type: "text", text: "cat: missing.txt: No such file or directory" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: true, durationMs: 2100 },
	);
	await sleep(10);
	const line = stripAnsi(wrapped.renderCall({ command: "cat missing.txt" }, theme, ctx).render(80)[0]);
	check("error suffix on call line", line.includes("✗ cat: missing.txt: No such file or directory (2.1s)"), line);
}

// Off: byte-exact delegation.
{
	const wrapperOff = makeResolver(() => false)("bash", () => native);
	const ctx = mkCtx();
	const call = wrapperOff.renderCall({ command: "git status" }, theme, ctx);
	check("off renderCall is native object", call?.tag === "native-call", call);
	const res = wrapperOff.renderResult(
		{ content: [{ type: "text", text: "x" }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);
	check("off renderResult is native object", res?.tag === "native-result", res);
}

// Expanded and partial: delegation.
{
	const ctx = mkCtx({ expanded: true });
	const call = wrapped.renderCall({ command: "git status" }, theme, ctx);
	check("expanded renderCall frames native object", call?.children?.[0]?.tag === "native-call", call);
	const res = wrapped.renderResult(
		{ content: [{ type: "text", text: "x" }] },
		{ expanded: true, isPartial: false },
		theme,
		ctx,
	);
	check("expanded renderResult joins native frame", res.render(80).length === 0 && call.children[1]?.tag === "native-result", res);
	const ctxP = mkCtx();
	const resP = wrapped.renderResult(
		{ content: [{ type: "text", text: "partial" }] },
		{ expanded: false, isPartial: true },
		theme,
		ctxP,
	);
	check("partial renderResult delegates inside public frame", resP?.children?.[0]?.tag === "native-result", resP);
}

// Native throws: fail-open fallbacks, never undefined.
{
	const throwing = {
		renderCall() {
			throw new Error("boom");
		},
		renderResult() {
			throw new Error("boom");
		},
	};
	const w = makeResolver(() => true)("bash", () => throwing);
	const call = w.renderCall({ command: "x" }, theme, mkCtx());
	check("native call throw → fallback component", call && typeof call.render === "function");
	const res = w.renderResult(
		{ content: [{ type: "text", text: "out" }] },
		{ expanded: false, isPartial: false },
		theme,
		mkCtx(),
	);
	check("native result throw → plain text fallback", res && typeof res.render === "function");
	const expandedCtx = mkCtx({ expanded: true });
	const expandedCall = w.renderCall({ command: "x" }, theme, expandedCtx);
	const expanded = w.renderResult(
		{ content: [{ type: "text", text: "out" }] },
		{ expanded: true, isPartial: false },
		theme,
		expandedCtx,
	);
	check("native throw expanded → plain text, has output", expanded.render(80).length === 0 &&
		stripAnsi(expandedCall.render(80).join("\n")).includes("out"));
}

// Multi-line tool (write): zen's own compact line.
{
	const w = makeResolver(() => true)("write", () => native);
	const ctx = mkCtx({ args: { file_path: "/a/b.ts", content: "1\n2\n3" } });
	const call = w.renderCall({ file_path: "/a/b.ts", content: "1\n2\n3" }, theme, ctx);
	const line = stripAnsi((call?.render?.(80) ?? [""])[0]);
	check("write compact call line", line.includes("write") && line.includes("/a/b.ts") && line.includes("(3 lines)"), line);
	check("write compact call is one line", (call?.render?.(80) ?? []).length === 1);
}

// Generic renderers (MCP-like tool).
{
	const g = makeResolver(() => true)("mcp__kb__search", () => undefined);
	const ctx = mkCtx();
	const call = g.renderCall({ query: "find docs" }, theme, ctx);
	const lines = (call?.render?.(80) ?? []).filter((line: string) => stripAnsi(line).trim());
	const line = stripAnsi(lines[0] ?? "");
	check("generic compact call one content line", lines.length === 1 && line.includes("find docs"), line);
	const res = g.renderResult(
		{ content: [{ type: "text", text: "result text" }] },
		{ expanded: false, isPartial: false },
		theme,
		mkCtx(),
	);
	check("generic collapsed result zero rows", (res?.render?.(80) ?? []).length === 0);
	const expandedCtx = mkCtx({ expanded: true });
	const expandedCall = g.renderCall({ query: "find docs" }, theme, expandedCtx);
	const expanded = g.renderResult(
		{ content: [{ type: "text", text: "result text" }] },
		{ expanded: true, isPartial: false },
		theme,
		expandedCtx,
	);
	check("generic expanded result shares call Text", (expanded?.render?.(80) ?? []).length === 0 &&
		stripAnsi(expandedCall.render(80).join("\n")).includes("result text"));
}

console.log("density summaries");
{
	check("preview removes terminal controls and line breaks", singleLine("one\n\u001b[31mtwo\u001b[0m\tthree\u009b2J") === "one two three");
	check("zero-width truncation is empty", truncateVisible("abc", 0) === "");
	check("wide-character truncation fits columns", visibleWidth(truncateVisible("日本語abc", 5)) <= 5);
	const metadata = infoFromResult({ content: [{ type: "text", text: "done" }], details: { truncation: { truncated: true } } }, { isError: false });
	check("generic nested objects do not serialize large values", condenseArgs({ nested: { data: "x".repeat(100000) } }) === "nested: object");
	check("generic arrays use bounded item summary", condenseArgs({ values: Array(1000).fill("x") }) === "values: 1000 items");
	check("structured truncation is visible", stripAnsi(suffixFor(metadata, theme)).includes("truncated"));
	check("metadata-only change is detected", infoChanged(okInfo, { ...okInfo, warning: "truncated" }));
	check("saved full output is visible", infoFromResult({ content: [], details: { fullOutputPath: "/tmp/log" } }, { isError: false }).warning === "full output");
	check("error preview sanitizes ANSI", infoFromResult({ content: [{ type: "text", text: "\u001b[31mfailed\u001b[0m" }] }, { isError: true }).errLine === "failed");
	const samples = [
		["read", { path: "/tmp/deep/folder/日本語/fixture.ts", offset: 120, limit: 61 }],
		["bash", { command: "printf '%s' \"" + "argument ".repeat(20) + "\"\nprintf next" }],
		["mcp", { tool: "browser_snapshot", args: { filename: "/tmp/capture" } }],
		["write", { path: "/tmp/folder/fixture.ts", content: "a\nb" }],
	] as const;
	for (const [tool, args] of samples) {
		const ctx = mkCtx({ args });
		const w = resolverOn(tool, () => native);
		w.renderCall(args, theme, ctx);
		w.renderResult({ content: [{ type: "text", text: "done" }] }, { expanded: false, isPartial: false }, theme, ctx);
		const row = w.renderCall(args, theme, ctx);
		for (const width of [1, 2, 12, 24, 40, 80]) {
			const lines = row.render(width);
			check(`${tool} one physical preview row at ${width}`, lines.length === 1 && lines.every((line: string) => visibleWidth(line) <= width));
		}
		const line = stripAnsi(row.render(80)[0]);
		if (tool === "read") check("relative path and read range kept", line.includes("fixture.ts:120–180"));
		if (tool === "mcp") check("MCP operation is visible", line.includes("mcp browser_snapshot"));
		if (tool === "bash") check("multiline command omission is visible", line.includes("…"));
	}
	await sleep(10);
}

console.log("native final result cleanup");
{
	let partialComponent: unknown;
	let finalCalls = 0;
	let reusedPartial = false;
	const cleanupNative = {
		renderCall: native.renderCall,
		renderResult(_result: any, options: any, _theme: any, ctx: any) {
			if (options.isPartial) {
				partialComponent = { render: () => ["partial"], invalidate() {} };
				return partialComponent;
			}
			finalCalls++;
			reusedPartial = ctx.lastComponent === partialComponent;
			return partialComponent;
		},
	};
	const w = makeResolver(() => true)("bash", () => cleanupNative);
	const ctx = mkCtx();
	w.renderCall({ command: "stream" }, theme, ctx);
	w.renderResult({ content: [{ type: "text", text: "partial" }] }, { expanded: false, isPartial: true }, theme, ctx);
	const result = { content: [{ type: "text", text: "done" }] };
	const final = w.renderResult(result, { expanded: false, isPartial: false }, theme, { ...ctx, durationMs: 500 });
	w.renderResult(result, { expanded: false, isPartial: false }, theme, { ...ctx, durationMs: 500, lastComponent: final });
	check("native final cleanup runs exactly once", finalCalls === 1);
	check("native final cleanup reuses partial component", reusedPartial);
	check("cleanup result stays hidden", final.render(80).length === 0);
	await sleep(10);
}

// ─── registry + lifecycle handlers ───────────────────────────────────────────

console.log("registry");
{
	// Build a fake pi API and run the default export.
	const events: Record<string, Array<(e?: unknown, ctx?: unknown) => void>> = {};
	const registrations: { flags: string[]; commands: string[]; shortcuts: string[]; renderers: number } = {
		flags: [],
		commands: [],
		shortcuts: [],
		renderers: 0,
	};
	const fakeCtx = () => ({ ui: { notify() {} } });
	const fakePi = {
		registerFlag: (name: string) => registrations.flags.push(name),
		getFlag: () => undefined,
		registerCommand: (name: string) => registrations.commands.push(name),
		registerShortcut: (name: string) => registrations.shortcuts.push(name),
		registerToolRenderer: () => registrations.renderers++,
		on: (name: string, fn: (e?: unknown, ctx?: unknown) => void) => {
			(events[name] ??= []).push(fn);
		},
	};
	saveFilterOn(true);
	(M as any).default(fakePi as any);

	check("registers flags", registrations.flags.includes("zen") && registrations.flags.includes("no-zen"));
	check("registers /zen command", registrations.commands.includes("zen"));
	check("registers ctrl+alt+t", registrations.shortcuts.includes("ctrl+alt+t"));
	check("registers one tool renderer", registrations.renderers === 1);

	// session_start reads the saved default (true).
	const startHandlers = events["session_start"] ?? [];
	check("has session_start handler", startHandlers.length === 1);
	startHandlers[0]?.({}, fakeCtx());

	// Renderers register invalidate closures during passes.
	const r = makeResolver(() => true)("bash", () => native);
	const ctx = mkCtx();
	r.renderCall({ command: "x" }, theme, ctx);
	check("registry grew after render pass", __registrySizeForTest() >= 1);
	startHandlers[0]?.({}, fakeCtx());
	check("session_start clears registry", __registrySizeForTest() === 0);
	r.renderCall({ command: "x" }, theme, ctx);
	check("registry grows again", __registrySizeForTest() >= 1);
	(events["session_tree"] ?? []).forEach((fn) => fn());
	check("session_tree clears registry", __registrySizeForTest() === 0);
	(events["compaction"] ?? []).forEach((fn) => fn());
	check("compaction handler exists and no-ops", (events["compaction"] ?? []).length === 1);
}

// ─── cleanup ─────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });
console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
