// Benchmark actual Pi tool components with the same Node runtime as the CLI.
// Run: node scripts/bench-zen-renderers.ts [iterations=2000] [trials=7]
// Optional: ZEN_BENCH_BASELINE=/path/to/old/zen.ts ZEN_BENCH_WIDTHS=40,80,120
// ZEN_BENCH_STREAM=1 adds partial update+render measurements. ZEN_BENCH_JSON=1
// emits raw trials, per-fixture summaries, aggregate summaries, and source hashes.
// Modes and measurements each rotate across trials. Setup and metadata scans
// stay outside timings. Config seams and explicit flags never use live settings.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim();
const modules = realpathSync(join(homedir(), ".pi/agent/install/releases", version, "node_modules"));
const base = join(modules, "@earendil-works/pi-coding-agent/dist");
const load = (path: string) => import(pathToFileURL(join(base, path)).href);
const { initTheme } = await load("modes/interactive/theme/theme.js");
initTheme("dark");
const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js");
const { createShellRenderers } = await load("core/tools/renderers/bash.js");
const { readRenderers } = await load("core/tools/renderers/read.js");
const { writeRenderers } = await load("core/tools/renderers/write.js");
const { lsRenderers } = await load("core/tools/renderers/ls.js");
const tui = await import(pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href);
const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
const native: Record<string, any> = {
	bash: createShellRenderers("$"), read: readRenderers, write: writeRenderers, ls: lsRenderers,
	mcp__registered: {}, mcp: {},
};
const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");
type Fixture = { id: string; tool: string; args: any; text: string; error?: boolean; details?: any };
const allFixtures: Fixture[] = [
	{ id: "bash-small", tool: "bash", args: { command: "git status" }, text: "On branch main\nnothing to commit" },
	{ id: "bash-large", tool: "bash", args: { command: "cat big.log" }, text: lines(500, "log line") },
	{ id: "bash-error", tool: "bash", args: { command: "cat missing.txt" }, text: "cat: missing.txt: No such file or directory", error: true },
	{ id: "read", tool: "read", args: { path: "/tmp/bench/fixture.txt" }, text: lines(200, "file content line") },
	{ id: "write", tool: "write", args: { path: "/tmp/bench/out.ts", content: lines(300, "export const value") }, text: "File created successfully" },
	{ id: "ls", tool: "ls", args: { path: "/tmp/bench" }, text: lines(60, "entry") },
	{ id: "unknown", tool: "mcp__unknown", args: { query: "internal knowledge base search", limit: 5 }, text: lines(40, "kb hit") },
	{ id: "registered", tool: "mcp__registered", args: { query: "internal knowledge base search", limit: 5 }, text: lines(40, "kb hit") },
	{ id: "bash-multiline", tool: "bash", args: { command: `printf '%s\\n' '${"long command argument ".repeat(12)}'\ngit status --short\nprintf '%s\\n' done`, timeout: 30 }, text: "long command argument\n M fixture.ts\ndone" },
	{ id: "read-unicode-range", tool: "read", args: { path: `/tmp/bench/${"日本語/資料/🧪-e\u0301/".repeat(7)}長いファイル名.txt`, offset: 1234, limit: 87 }, text: lines(87, "日本語 file content") },
	{ id: "mcp-proxy", tool: "mcp", args: { tool: "browser_snapshot", args: { filename: "/tmp/snapshot.md" } }, text: "Snapshot saved to /tmp/snapshot.md" },
	{ id: "read-truncated", tool: "read", args: { path: "/tmp/bench/truncated.txt", offset: 300, limit: 2000 }, text: lines(50, "truncated content"),
		details: { fullOutputPath: "/tmp/bench/full-output.txt", truncation: { truncated: true, truncatedBy: "lines", totalLines: 5000, outputLines: 50, totalBytes: 100000, outputBytes: 5000, maxLines: 50, maxBytes: 51200 } } },
	{ id: "error-multiline", tool: "bash", args: { command: "build fixture" }, text: `\n\nError: ${"日本語 🧪 e\u0301 build failure ".repeat(8)}\n    at compile (fixture.ts:42:7)\nCaused by: invalid input\n${lines(20, "stack frame")}`, error: true },
];
const selectedFixtures = process.env.ZEN_BENCH_FIXTURES?.split(",").filter(Boolean);
const fixtures = selectedFixtures ? allFixtures.filter((f) => selectedFixtures.includes(f.id)) : allFixtures;
if (!fixtures.length) throw Error("ZEN_BENCH_FIXTURES matched no fixture");
function positiveInteger(value: string, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) throw Error(`${label} must be a positive integer`);
	return number;
}
const iterations = positiveInteger(process.argv[2] ?? "2000", "iterations");
const trials = positiveInteger(process.argv[3] ?? "7", "trials");
const widths = [...new Set((process.env.ZEN_BENCH_WIDTHS ?? "80").split(/[,\s]+/).filter(Boolean)
	.map((value) => positiveInteger(value, "width")))];
if (!widths.length || widths.some((width) => width < 4)) throw Error("ZEN_BENCH_WIDTHS must contain widths of at least 4 columns");
const warmup = 100;
const streaming = process.env.ZEN_BENCH_STREAM === "1";
const scenarios = ["invalidate-render", "cached-render", ...(streaming ? ["stream-update-render"] : [])];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const durationMs = 421;
const resultFor = (fixture: Fixture, text = fixture.text, partial = false) => ({
	content: [{ type: "text", text }], details: partial ? {} : fixture.details ?? {},
	isError: partial ? false : !!fixture.error, durationMs: partial ? undefined : durationMs,
});
const sourceFor = (path: string) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
type Extension = { module: any; reset: () => void; resolve: (tool: string, next: () => any) => any; setOn: (on: boolean) => void };
type Mode = { name: string; implementation: string; expanded: boolean; extension?: Extension; on?: boolean };
type Row = {
	trial: number; fixture: string; mode: string; implementation: string; expanded: boolean; width: number; scenario: string;
	us: number; cpu_us: number; lines: number; peak_lines: number; peak_columns: number; redraws: number;
	final: { rows: number; max_columns: number; overflow_rows: number; status_present: boolean; isError: boolean; durationMs: number; text_chars: number; text_lines: number; details: any; native_timer_released: boolean };
};
const rows: Row[] = [];
const temp = mkdtempSync(join(tmpdir(), "zen-bench-"));
const extensions: Extension[] = [];
const sources: Record<string, { path: string; sha256: string }> = {};
const modes: Mode[] = [];

async function loadExtension(name: string, path: string): Promise<Extension> {
	sources[name] = sourceFor(path);
	// Disable module caching so even a same-path baseline has its own module state.
	// Share Pi's actual TUI classes, including when the baseline lives in /tmp.
	const module = await createJiti(import.meta.url, {
		moduleCache: false, fsCache: false, tryNative: false,
		virtualModules: { "@earendil-works/pi-tui": tui },
	}).import(path);
	if (typeof module.__setConfigPathForTest !== "function") throw Error(`${name} lacks the config test seam`);
	const config = join(temp, `${name}.json`);
	writeFileSync(config, JSON.stringify({ filter: false }));
	module.__setConfigPathForTest(config);
	let on = true;
	let start: Function | undefined;
	let resolver: Extension["resolve"] | undefined;
	module.default({ registerFlag() {}, registerCommand() {}, registerShortcut() {},
		registerToolRenderer(fn: Extension["resolve"]) { resolver = fn; },
		on(event: string, fn: Function) { if (event === "session_start") start = fn; },
		getFlag(flag: string) { return flag === "zen" ? on : flag === "no-zen" ? !on : false; },
	});
	if (!start || !resolver) throw Error(`${name} did not register its session hook and renderer`);
	const extension: Extension = { module, reset: () => start!({}, {}), resolve: resolver,
		setOn(value: boolean) { on = value; extension.reset(); } };
	extensions.push(extension);
	extension.reset();
	return extension;
}
function dimensions(output: string[], width: number) {
	const columns = output.map((line) => tui.visibleWidth(line));
	return { rows: output.length, max_columns: Math.max(0, ...columns), overflow_rows: columns.filter((count) => count > width).length };
}
async function measure(fixture: Fixture, mode: Mode, width: number, scenario: string, trial: number): Promise<void> {
	mode.extension?.setOn(mode.on !== false);
	const renderers = mode.extension ? mode.extension.resolve(fixture.tool, () => native[fixture.tool]) : native[fixture.tool];
	let redraws = 0;
	const c = new ToolExecutionComponent(fixture.tool, "tc-bench", fixture.args,
		{ showImages: false, outputPad: 1 }, renderers, { requestRender() { redraws++; } }, "/tmp/bench");
	const finalResult = resultFor(fixture);
	const partials = [1, 4, 12, 40].map((count) => resultFor(fixture, lines(count, "partial 日本語 output"), true));
	let peakLines = 0;
	let peakColumns = 0;
	try {
		if (mode.expanded) c.setExpanded(true);
		c.setArgsComplete();
		if (scenario === "stream-update-render") {
			c.markExecutionStarted();
			for (const partial of partials) {
				c.updateResult(partial, true);
				const d = dimensions(c.render(width), width);
				peakLines = Math.max(peakLines, d.rows);
				peakColumns = Math.max(peakColumns, d.max_columns);
			}
		} else {
			c.updateResult(finalResult, false);
			await wait(5); // Let Zen's deferred status repaint finish before warming.
			const output = c.render(width);
			if (mode.extension && mode.on !== false && !mode.expanded && !output.join("\n").includes(fixture.error ? "✗" : "✓")) {
				throw Error(`Missing status: ${fixture.id}, ${mode.name}, width ${width}`);
			}
		}
		const step = scenario === "stream-update-render" ? (i: number) => { c.updateResult(partials[i % partials.length], true); c.render(width); }
			: scenario === "cached-render" ? (_i: number) => { c.render(width); }
			: (_i: number) => { c.invalidate(); c.render(width); };
		// Retain the original invalidated warmup, then warm the measured path.
		for (let i = 0; i < warmup; i++) { c.invalidate(); c.render(width); }
		if (scenario !== "invalidate-render") for (let i = 0; i < warmup; i++) step(i);
		const beforeRedraws = redraws;
		const cpu0 = process.cpuUsage();
		const t0 = performance.now();
		for (let i = 0; i < iterations; i++) step(i);
		const elapsed = performance.now() - t0;
		const cpu = process.cpuUsage(cpu0);
		const measuredRedraws = redraws - beforeRedraws;
		// A final native result pass releases timers started by shell streaming.
		c.updateResult(finalResult, false);
		await wait(5);
		const output = c.render(width);
		const finalDimensions = dimensions(output, width);
		rows.push({ trial, fixture: fixture.id, mode: mode.name, implementation: mode.implementation,
			expanded: mode.expanded, width, scenario, us: elapsed * 1000 / iterations,
			cpu_us: (cpu.user + cpu.system) / iterations, lines: output.length,
			peak_lines: Math.max(peakLines, output.length), peak_columns: Math.max(peakColumns, finalDimensions.max_columns),
			redraws: measuredRedraws,
			final: { ...finalDimensions, status_present: output.join("\n").includes(fixture.error ? "✗" : "✓"),
				isError: !!fixture.error, durationMs, text_chars: fixture.text.length, text_lines: fixture.text.split("\n").length,
				details: finalResult.details, native_timer_released: !c.rendererState.interval } });
	} finally {
		try {
			c.updateResult(finalResult, false);
			await wait(5); // Drain deferred invalidations before clearing each registry.
		} finally {
			// Safety net on failed runs or old baselines. Do not leave an interval alive.
			const interval = c.rendererState.interval;
			if (interval) clearInterval(interval);
			mode.extension?.reset();
			if (interval) throw Error(`Native timer leaked: ${fixture.id}, ${mode.name}, ${scenario}`);
		}
	}
}

try {
	const candidate = await loadExtension("candidate", join(root, "pi/.pi/agent/extensions/zen.ts"));
	modes.push({ name: "bare", implementation: "bare", expanded: false },
		{ name: "zen", implementation: "candidate", expanded: false, extension: candidate },
		{ name: "bare-expanded", implementation: "bare", expanded: true },
		{ name: "expanded", implementation: "candidate", expanded: true, extension: candidate },
		{ name: "off", implementation: "candidate", expanded: false, extension: candidate, on: false });
	if (process.env.ZEN_BENCH_BASELINE) {
		const baseline = await loadExtension("baseline", resolve(process.env.ZEN_BENCH_BASELINE));
		if (baseline.module === candidate.module) throw Error("Baseline and candidate share module state");
		modes.push({ name: "baseline", implementation: "baseline", expanded: false, extension: baseline },
			{ name: "baseline-expanded", implementation: "baseline", expanded: true, extension: baseline });
	}
	// Seven modes with a baseline, so seven trials put each mode in every slot.
	// Rotate scenarios separately; adding cached renders cannot bias mode order.
	for (let trial = 0; trial < trials; trial++) for (const fixture of fixtures) for (const width of widths) {
		const modeOffset = trial % modes.length;
		const scenarioOffset = trial % scenarios.length;
		const modeOrder = modes.slice(modeOffset).concat(modes.slice(0, modeOffset));
		const scenarioOrder = scenarios.slice(scenarioOffset).concat(scenarios.slice(0, scenarioOffset));
		for (const mode of modeOrder) for (const scenario of scenarioOrder) await measure(fixture, mode, width, scenario, trial);
	}
} finally {
	for (const extension of extensions) extension.reset();
	rmSync(temp, { recursive: true, force: true });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summaries = widths.flatMap((width) => fixtures.flatMap((fixture) => modes.flatMap((mode) => scenarios.map((scenario) => {
	const selected = rows.filter((r) => r.fixture === fixture.id && r.mode === mode.name && r.width === width && r.scenario === scenario);
	const med = median(selected.map((r) => r.us));
	return { fixture: fixture.id, mode: mode.name, implementation: mode.implementation, expanded: mode.expanded, width, scenario,
		median_us: med, mad_us: median(selected.map((r) => Math.abs(r.us - med))),
		median_cpu_us: median(selected.map((r) => r.cpu_us)), peak_us: Math.max(...selected.map((r) => r.us)),
		peak_cpu_us: Math.max(...selected.map((r) => r.cpu_us)), rows: selected[0].lines,
		peak_rows: Math.max(...selected.map((r) => r.peak_lines)), peak_columns: Math.max(...selected.map((r) => r.peak_columns)),
		overflow_rows: Math.max(...selected.map((r) => r.final.overflow_rows)) };
}))));
const aggregates = widths.flatMap((width) => modes.flatMap((mode) => scenarios.map((scenario) => {
	const selected = summaries.filter((s) => s.width === width && s.mode === mode.name && s.scenario === scenario);
	return { width, mode: mode.name, implementation: mode.implementation, expanded: mode.expanded, scenario,
		mean_fixture_median_us: selected.reduce((sum, s) => sum + s.median_us, 0) / selected.length,
		peak_trial_us: Math.max(...selected.map((s) => s.peak_us)), peak_rows: Math.max(...selected.map((s) => s.peak_rows)),
		peak_columns: Math.max(...selected.map((s) => s.peak_columns)), fixtures: selected.length };
})));
if (process.env.ZEN_BENCH_JSON) {
	console.log(JSON.stringify({ schema_version: 2, runtime: process.version, pi: version, iterations, trials, widths, warmup,
		streaming, sources, modes: modes.map(({ name, implementation, expanded, on }) => ({ name, implementation, expanded, on })), scenarios,
		measurement: { unit: "us per operation", peak: "maximum trial mean, not per-operation latency", theme: "dark", outputPad: 1, settle_ms: 5, partial_frames: streaming ? 4 : 0 },
		fixtures: fixtures.map(({ id, tool, args, error, text, details }) => ({ id, tool, args, isError: !!error,
			text_chars: text.length, text_lines: text.split("\n").length, details: details ?? {} })), rows, summaries, aggregates }));
} else {
	console.log(`Pi ${version}, ${process.version}, widths ${widths.join(",")}, ${iterations} iterations, ${trials} rotated trials`);
	for (const [name, source] of Object.entries(sources)) console.log(`${name}: ${source.path} (${source.sha256})`);
	console.log("Peak µs is the slowest trial mean. Stream peaks sample four partial frames and final output.");
	console.log("fixture              mode                width scenario             median µs   MAD µs  peak µs  rows peak rows overflow");
	for (const s of summaries) console.log(`${s.fixture.padEnd(20)} ${s.mode.padEnd(19)} ${String(s.width).padStart(5)} ${s.scenario.padEnd(20)} ${s.median_us.toFixed(2).padStart(9)} ${s.mad_us.toFixed(2).padStart(8)} ${s.peak_us.toFixed(2).padStart(8)} ${String(s.rows).padStart(5)} ${String(s.peak_rows).padStart(9)} ${String(s.overflow_rows).padStart(8)}`);
	console.log("Summary: equal-weight mean of fixture medians, plus peak trial and row count");
	for (const a of aggregates) console.log(`${a.mode.padEnd(19)} width ${a.width} ${a.scenario.padEnd(20)} mean ${a.mean_fixture_median_us.toFixed(2)} µs, peak ${a.peak_trial_us.toFixed(2)} µs, peak rows ${a.peak_rows}`);
}
