// Benchmark actual Pi tool components with the same Node runtime as the CLI.
// Run: node scripts/bench-zen-renderers.ts [iterations=2000] [trials=7]
// Includes shared renderer state, prior components, final status, native shell,
// and deferred invalidation. Variant order rotates across trials.
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
const { initTheme, theme } = await load("modes/interactive/theme/theme.js");
initTheme("dark");
const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js");
const { createShellRenderers } = await load("core/tools/renderers/bash.js");
const { readRenderers } = await load("core/tools/renderers/read.js");
const { writeRenderers } = await load("core/tools/renderers/write.js");
const { lsRenderers } = await load("core/tools/renderers/ls.js");
const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
const zen = await createJiti(import.meta.url).import(join(root, "pi/.pi/agent/extensions/zen.ts"));
const native: Record<string, any> = {
	bash: createShellRenderers("$"), read: readRenderers, write: writeRenderers, ls: lsRenderers,
	mcp__registered: {},
};
const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");
const fixtures = [
	{ id: "bash-small", tool: "bash", args: { command: "git status" }, text: "On branch main\nnothing to commit" },
	{ id: "bash-large", tool: "bash", args: { command: "cat big.log" }, text: lines(500, "log line") },
	{ id: "bash-error", tool: "bash", args: { command: "cat missing.txt" }, text: "cat: missing.txt: No such file or directory", error: true },
	{ id: "read", tool: "read", args: { path: "/tmp/bench/fixture.txt" }, text: lines(200, "file content line") },
	{ id: "write", tool: "write", args: { path: "/tmp/bench/out.ts", content: lines(300, "export const value") }, text: "File created successfully" },
	{ id: "ls", tool: "ls", args: { path: "/tmp/bench" }, text: lines(60, "entry") },
	{ id: "unknown", tool: "mcp__unknown", args: { query: "internal knowledge base search", limit: 5 }, text: lines(40, "kb hit") },
	{ id: "registered", tool: "mcp__registered", args: { query: "internal knowledge base search", limit: 5 }, text: lines(40, "kb hit") },
];
const iterations = Number(process.argv[2] ?? 2000);
const trials = Number(process.argv[3] ?? 7);
const modes = ["bare", "zen", "bare-expanded", "expanded", "off"];
const resolver = zen.makeResolver(() => true);
const rows: Array<{ trial: number; fixture: string; mode: string; us: number; cpu_us: number; lines: number }> = [];
let reset: Function;
function install(on: boolean) {
	zen.default({ registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerToolRenderer() {},
		on(name: string, fn: Function) { if (name === "session_start") reset = fn; },
		getFlag(name: string) { return name === (on ? "zen" : "no-zen"); },
	});
	reset({}, {});
}
for (let trial = 0; trial < trials; trial++) {
	for (const fixture of fixtures) {
		const order = modes.slice(trial % modes.length).concat(modes.slice(0, trial % modes.length));
		for (const mode of order) {
			install(mode !== "off");
			const renderers = ["bare", "bare-expanded", "off"].includes(mode) ? native[fixture.tool] :
				resolver(fixture.tool, () => native[fixture.tool]);
			const c = new ToolExecutionComponent(fixture.tool, "tc-bench", fixture.args, { showImages: false, outputPad: 1 }, renderers, { requestRender() {} }, "/tmp/bench");
			if (mode === "expanded" || mode === "bare-expanded") c.setExpanded(true);
			c.setArgsComplete();
			c.updateResult({ content: [{ type: "text", text: fixture.text }], details: {}, isError: !!fixture.error, durationMs: 421 }, false);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const output = c.render(80);
			if (mode === "zen" && !output.join("\n").includes(fixture.error ? "✗" : "✓")) throw Error("Missing status: " + fixture.id);
			for (let i = 0; i < 100; i++) { c.invalidate(); c.render(80); }
			const cpu0 = process.cpuUsage();
			const t0 = performance.now();
			for (let i = 0; i < iterations; i++) { c.invalidate(); c.render(80); }
			const elapsed = performance.now() - t0;
			const cpu = process.cpuUsage(cpu0);
			rows.push({ trial, fixture: fixture.id, mode, us: elapsed * 1000 / iterations, cpu_us: (cpu.user + cpu.system) / iterations, lines: output.length });
			reset({}, {});
		}
	}
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
if (process.env.ZEN_BENCH_JSON) {
	console.log(JSON.stringify({ runtime: process.version, pi: version, iterations, trials, rows }));
} else {
	console.log(`Pi ${version}, ${process.version}, width 80, ${iterations} iterations, ${trials} rotated trials`);
	console.log("fixture       mode             median µs   MAD µs   rows");
	for (const fixture of fixtures) for (const mode of modes) {
		const selected = rows.filter((r) => r.fixture === fixture.id && r.mode === mode);
		const values = selected.map((r) => r.us);
		const med = median(values);
		const mad = median(values.map((v) => Math.abs(v - med)));
		console.log(`${fixture.id.padEnd(13)} ${mode.padEnd(16)} ${med.toFixed(2).padStart(9)} ${mad.toFixed(2).padStart(8)} ${String(selected[0].lines).padStart(6)}`);
	}
}
