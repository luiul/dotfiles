// Actual Pi renderer comparison under its Node runtime.
// ZEN_BENCH_BASELINE=/path/to/zen.ts node scripts/bench-zen-renderers.ts 150 7
// ZEN_BENCH_JSON=1 emits all rotated trial measurements.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
	"@earendil-works/pi-coding-agent": join(base, "index.js"),
} });
const zen = await jiti.import(join(root, "pi/.pi/agent/extensions/zen.ts"));
const baseline = process.env.ZEN_BENCH_BASELINE ? await jiti.import(process.env.ZEN_BENCH_BASELINE) : undefined;
const variants = [{ id: "bare", module: undefined }, ...(baseline ? [{ id: "baseline", module: baseline }] : []), { id: "candidate", module: zen }];
const native: Record<string, any> = {
	bash: createShellRenderers("$"), read: readRenderers, write: writeRenderers, ls: lsRenderers, registered: {},
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `fixture line ${i}`).join("\n");
const fixtures = [
	{ id: "bash-small", tool: "bash", args: { command: "git status" }, text: "On branch main\nnothing to commit" },
	{ id: "bash-large", tool: "bash", args: { command: "cat big.log" }, text: lines(500) },
	{ id: "bash-error", tool: "bash", args: { command: "cat missing.txt" }, text: "cat: missing.txt: No such file or directory", error: true },
	{ id: "read", tool: "read", args: { path: "/tmp/bench/fixture.txt" }, text: lines(200) },
	{ id: "write", tool: "write", args: { path: "/tmp/bench/out.ts", content: lines(300) }, text: "File created successfully" },
	{ id: "ls", tool: "ls", args: { path: "/tmp/bench" }, text: lines(60) },
	{ id: "unknown", tool: "unknown", args: { query: "internal search", limit: 5 }, text: lines(40) },
	{ id: "registered", tool: "registered", args: { query: "internal search", limit: 5 }, text: lines(40) },
];
const iterations = Number(process.argv[2] ?? 150);
const trials = Number(process.argv[3] ?? 7);
const modes = ["compact", "expanded", "off"];
const phases = ["cached", "invalidated", "streaming", "first-paint"];
const rows: any[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function install(module: any, on: boolean) {
	if (!module) return () => {};
	let reset: Function = () => {};
	module.default({ registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerToolRenderer() {},
		on(name: string, fn: Function) { if (name === "session_start") reset = fn; },
		getFlag(name: string) { return name === (on ? "zen" : "no-zen"); },
	});
	reset({}, {});
	return reset;
}
for (let trial = 0; trial < trials; trial++) {
	for (const fixture of fixtures) for (const mode of modes) for (const phase of phases) {
		const order = variants.slice(trial % variants.length).concat(variants.slice(0, trial % variants.length));
		for (const variant of order) {
			const reset = install(variant.module, mode !== "off");
			let requests = 0;
			const renderer = () => variant.module ? variant.module.makeResolver(() => mode !== "off")(fixture.tool, () => native[fixture.tool]) : native[fixture.tool];
			const make = () => {
				const c = new ToolExecutionComponent(fixture.tool, "bench", fixture.args, { showImages: false, outputPad: 1 }, renderer(), { requestRender() { requests++; } }, "/tmp/bench");
				if (mode === "expanded") c.setExpanded(true);
				return c;
			};
			const c = make();
			const final = { content: [{ type: "text", text: fixture.text }], details: {}, isError: !!fixture.error, durationMs: 421 };
			const partials = [0, 1].map(i => ({ content: [{ type: "text", text: fixture.text + `\npartial ${i}` }], details: {}, isError: false }));
			c.setArgsComplete(); c.markExecutionStarted();
			if (phase === "streaming") c.updateResult(partials[0], true);
			else c.updateResult(final, false);
			await sleep(2);
			const run = (i: number) => {
				if (phase === "first-paint") { const fresh = make(); fresh.render(80); return; }
				if (phase === "streaming") c.updateResult(partials[i % 2], true);
				else if (phase === "invalidated") c.invalidate();
				c.render(80);
			};
			const count = phase === "first-paint" ? Math.min(iterations, 300) : iterations;
			for (let i = 0; i < 50; i++) run(i);
			const cpu0 = process.cpuUsage(), start = performance.now();
			for (let i = 0; i < count; i++) run(i);
			const elapsed = performance.now() - start, cpu = process.cpuUsage(cpu0);
			rows.push({ trial, fixture: fixture.id, variant: variant.id, mode, phase, us: elapsed * 1000 / count,
				cpu_us: (cpu.user + cpu.system) / count, lines: c.render(80).length, requests });
			c.updateResult(final, false);
			await sleep(2); // Baseline completion repaints and timer cleanup are included.
			reset({}, {});
		}
	}
}
const median = (a: number[]) => a.sort((a, b) => a - b)[Math.floor(a.length / 2)];
if (process.env.ZEN_BENCH_JSON) console.log(JSON.stringify({ runtime: process.version, pi: version, iterations, trials, rows }));
else {
	console.log(`Pi ${version}, ${process.version}, width 80, ${iterations} iterations, ${trials} rotated trials`);
	console.log("fixture       variant    mode       phase         median µs    MAD µs   rows");
	for (const fixture of fixtures) for (const mode of modes) for (const phase of phases) for (const variant of variants) {
		const selected = rows.filter(r => r.fixture === fixture.id && r.variant === variant.id && r.mode === mode && r.phase === phase);
		const med = median(selected.map(r => r.us)), mad = median(selected.map(r => Math.abs(r.us - med)));
		console.log(`${fixture.id.padEnd(13)} ${variant.id.padEnd(10)} ${mode.padEnd(10)} ${phase.padEnd(13)} ${med.toFixed(2).padStart(10)} ${mad.toFixed(2).padStart(9)} ${String(selected[0].lines).padStart(6)}`);
	}
}
