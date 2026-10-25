// Micro-benchmark for pi tool-call renderers (zen v2 effort, issues #67/#68).
//
// Measures the cost of renderCall + renderResult + one render() pass per
// component, the same sequence pi's ToolExecutionComponent.updateDisplay runs
// on every tool event. Baselines pi's native renderers; after zen v2 lands,
// the zen contestant is added and compared on the same fixtures.
//
// Contestants are renderer providers keyed by tool name, matching the
// ToolRenderers shape pi hands to components ({ renderCall, renderResult }).
// The native contestant imports pi's own renderer modules from the installed
// release (see PI_BASE below).
//
// Run: bun scripts/bench-zen-renderers.ts [iterations]
// Default iterations: 10000 per (contestant, tool, fixture) cell.

import { performance } from "node:perf_hooks";

// ─── pi install resolution ───────────────────────────────────────────────────

/** The installed pi release whose renderers are the baseline. */
const PI_BASE =
	"/Users/luis.aceituno/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist";

/** Renderer modules and their exports, imported once per run. */
const [themeMod, bashMod, readMod, writeMod, lsMod] = await Promise.all([
	import(PI_BASE + "/modes/interactive/theme/theme.js"),
	import(PI_BASE + "/core/tools/renderers/bash.js"),
	import(PI_BASE + "/core/tools/renderers/read.js"),
	import(PI_BASE + "/core/tools/renderers/write.js"),
	import(PI_BASE + "/core/tools/renderers/ls.js"),
]);
themeMod.initTheme("dark");
const theme = themeMod.theme;

// ─── fake context plumbing ──────────────────────────────────────────────────

/**
 * A minimal ToolRenderContext, duck-typed to what the renderers touch. One
 * per simulated component lifetime field: renderers share `state` across
 * call and result for one component; components are reused across updates
 * (lastComponent), so the benchmark reuses them across iterations too.
 */
function makeContext(extra = {}) {
	return {
		state: {},
		lastComponent: undefined,
		invalidate() {},
		cwd: "/tmp/bench",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		toolCallId: "tc-bench",
		args: undefined,
		...extra,
	};
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Many lines of realistic-ish content for large-output fixtures. */
const manyLines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

const result = (text, isError = false) => ({
	content: [{ type: "text", text }],
	isError,
	durationMs: 421,
	details: {},
});

/**
 * The fixture table: one entry per (tool, scenario). `run` receives the
 * contestant's renderers and executes ONE updateDisplay-equivalent pass,
 * reusing the call/result components the way pi does across updates.
 */
const FIXTURES = [
	{
		id: "bash/success-small",
		tool: "bash",
		args: { command: "git status" },
		result: result("On branch main\nnothing to commit, working tree clean"),
	},
	{
		id: "bash/success-large",
		tool: "bash",
		args: { command: "cat big.log" },
		result: result(manyLines(500, "log line")),
	},
	{
		id: "bash/error",
		tool: "bash",
		args: { command: "cat missing.txt" },
		result: result("cat: missing.txt: No such file or directory", true),
	},
	{
		id: "read/collapsed",
		tool: "read",
		args: { path: "/tmp/bench/fixture.txt" },
		result: result(manyLines(200, "file content line")),
	},
	{
		id: "write/content",
		tool: "write",
		args: { file_path: "/tmp/bench/out.ts", content: manyLines(300, "export const value") },
		result: result("File created successfully"),
	},
	{
		id: "ls/many",
		tool: "ls",
		args: { path: "/tmp/bench" },
		result: result(manyLines(60, "entry")),
	},
	{
		// No native renderer exists for unknown/MCP tools; zen v2's generic
		// renderer owns these (native has nothing to compare).
		id: "mcp/generic",
		tool: "mcp__kb__search",
		args: { query: "internal knowledge base search", limit: 5 },
		result: result(manyLines(40, "kb hit")),
	},
	// Expanded variants: zen v2 delegates to native, so the acceptance
	// criterion is "within 5% of native" for these.
	{
		id: "bash/success-large-expanded",
		tool: "bash",
		expanded: true,
		args: { command: "cat big.log" },
		result: result(manyLines(500, "log line")),
	},
	{
		id: "write/content-expanded",
		tool: "write",
		expanded: true,
		args: { file_path: "/tmp/bench/out.ts", content: manyLines(300, "export const value") },
		result: result("File created successfully"),
	},
	{
		id: "mcp/generic-expanded",
		tool: "mcp__kb__search",
		expanded: true,
		args: { query: "internal knowledge base search", limit: 5 },
		result: result(manyLines(40, "kb hit")),
	},
];

// ─── contestants ──────────────────────────────────────────────────────────────

type Renderers = {
	renderCall?: (args: any, theme: any, ctx: any) => any;
	renderResult?: (result: any, options: any, theme: any, ctx: any) => any;
};

/** pi's own renderers, as ToolExecutionComponent would receive them. */
const nativeRenderers: Record<string, Renderers> = {
	bash: bashMod.createShellRenderers("$"),
	read: readMod.readRenderers,
	write: writeMod.writeRenderers,
	ls: lsMod.lsRenderers,
};

const CONTESTANTS: Array<{ name: string; get: (tool: string) => Renderers | undefined }> = [
	{ name: "native", get: (tool) => nativeRenderers[tool] },
];

// The zen v2 contestant: zen's resolver wrapping the native renderers,
// compact mode forced on. Unknown/MCP tools resolve to zen's generic
// renderers (native next() returns undefined for them).
const zen = await import("../pi/.pi/agent/extensions/zen.ts");
const zenResolver = zen.makeResolver(() => true);
CONTESTANTS.push({
	name: "zen2",
	get: (tool) => zenResolver(tool, () => nativeRenderers[tool]),
});

// ─── measurement ──────────────────────────────────────────────────────────────

const WIDTH = 80;
const WARMUP = 500;
const ITERATIONS = Number(process.argv[2] ?? 10000);

// Per-fixture stashed component state (component reuse across iterations,
// matching pi's updateDisplay reuse via lastComponent).
const stash = new WeakMap<object, any>();
function stashed(fixture: object) {
	if (!stash.has(fixture)) stash.set(fixture, {});
	return stash.get(fixture);
}

const rows: Array<{ contestant: string; fixture: string; usPerIter: number; lines: number }> = [];

for (const contestant of CONTESTANTS) {
	for (const fixture of FIXTURES) {
		const renderers = contestant.get(fixture.tool);
		if (!renderers?.renderCall || !renderers?.renderResult) continue;
		const s = stashed(fixture);
		s.__callCtx = undefined;
		s.__callComponent = undefined;
		s.__resultCtx = undefined;
		s.__resultComponent = undefined;
		const run = () => {
			s.__callCtx ??= makeContext({ args: fixture.args, expanded: !!fixture.expanded });
			s.__callCtx.state = {};
			s.__callCtx.lastComponent = s.__callComponent;
			const callComponent = renderers.renderCall!(fixture.args, theme, s.__callCtx);
			s.__callComponent = callComponent;
			s.__resultCtx ??= makeContext({ args: fixture.args, expanded: !!fixture.expanded });
			s.__resultCtx.state = {};
			s.__resultCtx.lastComponent = s.__resultComponent;
			const resultComponent = renderers.renderResult!(
				fixture.result,
				{ expanded: !!fixture.expanded, isPartial: false },
				theme,
				s.__resultCtx,
			);
			s.__resultComponent = resultComponent;
			return (
				(callComponent?.render?.(WIDTH)?.length ?? 0) + (resultComponent?.render?.(WIDTH)?.length ?? 0)
			);
		};

		let lines = 0;
		for (let i = 0; i < WARMUP; i++) lines = run();
		const t0 = performance.now();
		for (let i = 0; i < ITERATIONS; i++) lines = run();
		const elapsed = performance.now() - t0;
		rows.push({
			contestant: contestant.name,
			fixture: fixture.id,
			usPerIter: (elapsed * 1000) / ITERATIONS,
			lines,
		});
	}
}

// ─── report ───────────────────────────────────────────────────────────────────

console.log(`pi renderer micro-benchmark (${ITERATIONS} iterations, width ${WIDTH}, theme dark)`);
console.log(`pi base: ${PI_BASE}`);
console.log("");
console.log("contestant  fixture                µs/iter   lines");
console.log("──────────  ────────────────────  ────────  ─────");
for (const r of rows) {
	console.log(
		`${r.contestant.padEnd(10)}  ${r.fixture.padEnd(20)}  ${r.usPerIter.toFixed(2).padStart(8)}  ${String(r.lines).padStart(5)}`,
	);
}
