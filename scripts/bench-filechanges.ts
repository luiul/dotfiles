// Run with Node, not Bun: node scripts/bench-filechanges.ts [iterations=2000] [trials=5]
// FILECHANGES_BENCH_BASELINE=/path/with/filechanges.ts/and/filechanges-tracker.ts
// FILECHANGES_BENCH_JSON=/absolute/path/results.json (or '-' for JSON stdout)
// Options: --variants=bare,baseline,candidate --hook-iterations=3 --restore-items=20
//          --iterations=2000 --trials=5 --timeout-ms=180000
// Each trial/variant runs in a fresh, bounded Node child. Variant order rotates.
// This is a renderer/hook harness, NOT real interactive Pi host startup.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

if ((process.versions as any).bun) throw new Error("Use Node for comparable CPU and RSS measurements");
const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
	const arg = args.find((arg) => arg.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : fallback;
}
function integer(name: string, fallback: string, max: number): number {
	const value = Number(option(name, fallback));
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}, expected 1..${max}`);
	return value;
}
const positional = args.filter((arg) => !arg.startsWith("--"));
const iterations = integer("iterations", positional[0] ?? "2000", 1_000_000);
const trials = integer("trials", positional[1] ?? "5", 100);
const hookIterations = integer("hook-iterations", "3", 1000);
const restoreItems = integer("restore-items", "20", 200);
const timeoutMs = integer("timeout-ms", "180000", 3_600_000);
const baseline = process.env.FILECHANGES_BENCH_BASELINE ? resolve(process.env.FILECHANGES_BENCH_BASELINE) : undefined;
const candidate = join(root, "pi/.pi/agent/extensions");
const zenPath = join(homedir(), "dotfiles/pi/.pi/agent/extensions/zen.ts");
const version = readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim();
const modules = realpathSync(join(homedir(), ".pi/agent/install/releases", version, "node_modules"));
const base = join(modules, "@earendil-works/pi-coding-agent/dist");
const sizes = [1, 20, 200];
const widths = [40, 80, 120];
type Variant = "bare" | "baseline" | "candidate";
type Component = { render(width: number): string[]; invalidate(): void; dispose?(): void };
type Row = {
	variant: Variant; trial: number; suite: string; scenario: string; items: number; sample: number;
	operations: number; wall_us: number; cpu_us: number; user_us: number; system_us: number;
	exec_file_calls: number; subprocesses: Record<string, number>; rss_before_bytes: number; rss_after_bytes: number;
	lines?: number; widget_sets?: number; render_requests?: number; appended?: number;
};
const assumptions = [
	"Harness only: no model, full Pi host, terminal writes, session discovery, or other extensions. Real Pi startup must be measured separately.",
	"Installed Pi dark theme and Text/Container. Baseline string widgets use Text(line,1,0), capped at 10 logical lines, as in installed InteractiveMode. These Text children can wrap to more physical lines.",
	"The renderers have different row budgets: baseline shows up to 8 file rows plus header/overflow; candidate shows up to 6 plus header/overflow. layout_fixtures records physical rows for 20 long paths at each width, separately from timing workloads.",
	"Renderer factory uses an aliased fixture tracker. Cached/invalidate/resize omit snapshot updates; publish-render alternates prebuilt immutable snapshots and includes subscription refresh/widget work, not tracker sorting or snapshot creation.",
	"Renderer wall/CPU are batch means per operation. Median/p95 summarize trial batch means, not individual render tail latency.",
	"Hook timings are individual awaited mock dispatches. Normal tool_execution_end follows each tool_result and is timed separately, with zero subprocesses asserted. Tool filesystem/shell bodies and fixture Git setup are excluded. No real tool implementation is timed.",
	"Module load is extension-only Jiti load with installed Pi preloaded and fsCache disabled. It is not cold process or live host startup.",
	"CPU is Node parent user+system time, excluding Git/shell child CPU; wall time includes awaited subprocesses.",
	"Subprocess counts instrument child_process.execFile before Jiti load; fixture setup/body commands are excluded. Counts are not all possible spawn APIs.",
	"RSS is absolute sampled worker process RSS, not retained extension memory. Fresh process per variant/trial; no forced GC; maxRSS is whole-worker high water.",
	"Fixtures are real Git repos under the home directory, outside OS temp roots. The tmp test seam excludes a separate fixture subdirectory only.",
	"Live Zen is a separate renderer reference, not part of filechanges variant overhead and never installed into hook mocks.",
];
function fingerprint(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function quantile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * q;
	const lower = Math.floor(position);
	return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}
function summarize(rows: Row[]) {
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		const key = `${row.suite}/${row.scenario}/${row.items}/${row.variant}`;
		const group = groups.get(key) ?? [];
		group.push(row); groups.set(key, group);
	}
	return [...groups.entries()].map(([key, values]) => ({
		key, samples: values.length, wall_median_us: quantile(values.map((v) => v.wall_us), 0.5),
		wall_p95_us: quantile(values.map((v) => v.wall_us), 0.95),
		cpu_median_us: quantile(values.map((v) => v.cpu_us), 0.5), cpu_p95_us: quantile(values.map((v) => v.cpu_us), 0.95),
		exec_file_median_per_op: quantile(values.map((v) => v.exec_file_calls / v.operations), 0.5),
		rss_median_mib: quantile(values.map((v) => v.rss_after_bytes / 2 ** 20), 0.5),
		rss_max_sampled_mib: Math.max(...values.map((v) => Math.max(v.rss_before_bytes, v.rss_after_bytes) / 2 ** 20)),
	}));
}

if (!args.includes("--worker")) {
	const variants = option("variants", baseline ? "bare,baseline,candidate" : "bare,candidate").split(",") as Variant[];
	if (!variants.length || new Set(variants).size !== variants.length || variants.some((v) => !["bare", "baseline", "candidate"].includes(v))) {
		throw new Error("--variants must be a unique list from bare,baseline,candidate");
	}
	if (variants.includes("baseline") && !baseline) throw new Error("Set FILECHANGES_BENCH_BASELINE to a directory containing filechanges.ts and filechanges-tracker.ts when --variants includes baseline");
	const sources: Record<string, any> = {};
	for (const variant of variants) if (variant !== "bare") {
		const dir = variant === "baseline" ? baseline! : candidate;
		sources[variant] = Object.fromEntries(["filechanges.ts", "filechanges-tracker.ts"].map((name) => {
			const path = join(dir, name);
			if (!existsSync(path)) throw new Error(`Missing ${path}`);
			return [name, { path, sha256: fingerprint(path) }];
		}));
	}
	const zenSha256 = fingerprint(zenPath);
	const benchmarkSources = Object.fromEntries([script, join(root, "scripts/bench-filechanges-renderer-mock.ts")].map((path) => [basename(path), { path, sha256: fingerprint(path) }]));
	const layoutFixtures: any[] = [];
	const rows: Row[] = [];
	const workers: any[] = [];
	const started = new Date().toISOString();
	for (let trial = 0; trial < trials; trial++) {
		const offset = trial % variants.length;
		const order = [...variants.slice(offset), ...variants.slice(0, offset)];
		for (const variant of order) {
			process.stderr.write(`filechanges harness: trial ${trial + 1}/${trials}, ${variant}\n`);
			const stdout = childProcess.execFileSync(process.execPath, [script, "--worker", `--variant=${variant}`, `--trial=${trial}`,
				`--iterations=${iterations}`, `--hook-iterations=${hookIterations}`, `--restore-items=${restoreItems}`, `--timeout-ms=${timeoutMs}`],
				{ encoding: "utf8", timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 10 * 1024 * 1024 });
			const worker = JSON.parse(stdout);
			rows.push(...worker.rows); layoutFixtures.push(...worker.layout_fixtures);
			workers.push({ ...worker, rows: undefined, layout_fixtures: undefined });
		}
	}
	// Refuse to combine numbers from sources changed by parallel agents during a run.
	for (const source of Object.values(sources) as any[]) for (const entry of Object.values(source) as any[]) {
		if (fingerprint(entry.path) !== entry.sha256) throw new Error(`Source changed while benchmarking: ${entry.path}. Re-run after edits settle.`);
	}
	if (fingerprint(zenPath) !== zenSha256) throw new Error(`Zen source changed while benchmarking: ${zenPath}`);
	for (const entry of Object.values(benchmarkSources)) if (fingerprint(entry.path) !== entry.sha256) throw new Error(`Benchmark source changed while running: ${entry.path}`);
	const artifact = { schema_version: 1, started, finished: new Date().toISOString(), runtime: process.version,
		executable: process.execPath, platform: process.platform, arch: process.arch, pi: version,
		settings: { iterations, trials, hookIterations, restoreItems, sizes, widths, timeoutMs, variants },
		sources, benchmark_sources: benchmarkSources, zen: { path: zenPath, sha256: zenSha256 }, assumptions, workers,
		layout_fixtures: layoutFixtures, summary: summarize(rows), rows };
	const output = process.env.FILECHANGES_BENCH_JSON;
	if (output && output !== "-") writeFileSync(resolve(output), JSON.stringify(artifact, null, 2) + "\n");
	if (output === "-") console.log(JSON.stringify(artifact));
	else {
		console.log(`Harness only, Pi ${version}, Node ${process.version}, ${iterations} renderer iterations, ${trials} rotated trials`);
		console.log("suite/scenario/items/variant                              median us    p95 us   CPU us  exec/op RSS MiB");
		for (const row of artifact.summary) console.log(`${row.key.padEnd(57)} ${row.wall_median_us.toFixed(2).padStart(10)} ${row.wall_p95_us.toFixed(2).padStart(9)} ${row.cpu_median_us.toFixed(2).padStart(8)} ${row.exec_file_median_per_op.toFixed(2).padStart(8)} ${row.rss_median_mib.toFixed(1).padStart(7)}`);
		console.log("p95 renderer values are trial batch means. CPU excludes subprocess CPU; RSS is absolute worker RSS.");
		if (output) console.log(`JSON: ${resolve(output)}`);
	}
} else {
	const variant = option("variant", "bare") as Variant;
	const trial = Number(option("trial", "0"));
	const layoutFixtures: any[] = [];
	const rows: Row[] = [];
	let active: Record<string, number> | undefined;
	const originalExecFile = childProcess.execFile;
	const children = new Set<any>();
	// Patch the CJS export AND the ESM binding before any Jiti extension import.
	(childProcess as any).execFile = function (file: string, ...args: any[]) {
		if (active) {
			const argv = Array.isArray(args[0]) ? args[0] : [];
			const command = [basename(file), argv[0] ?? ""].join(" ").trim();
			active[command] = (active[command] ?? 0) + 1;
		}
		// Preserve stdout/stderr on promisify without hiding launches behind custom symbols.
		const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
		const optsIndex = Array.isArray(args[0]) ? 1 : 0;
		args[optsIndex] = { ...(args[optsIndex] ?? {}), timeout: Math.min(args[optsIndex]?.timeout || 10000, 10000), killSignal: "SIGKILL" };
		const child = (originalExecFile as any).call(childProcess, file, ...args, callback);
		children.add(child);
		child.once("close", () => children.delete(child));
		return child;
	};
	(childProcess.execFile as any)[promisify.custom] = (file: string, ...args: any[]) => new Promise((resolve, reject) => {
		(childProcess.execFile as any)(file, ...args, (error: any, stdout: any, stderr: any) => {
			if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
			else resolve({ stdout, stderr });
		});
	});
	syncBuiltinESMExports();
	const exec = promisify(childProcess.execFile) as any;
	const load = (path: string) => import(pathToFileURL(join(base, path)).href);
	const { initTheme, theme } = await load("modes/interactive/theme/theme.js");
	initTheme("dark");
	const { Text, Container, visibleWidth, stripTerminalSequences } = await import(pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href);
	// Installed dependencies are ready before extension-only module-load measurement.
	await load("index.js");
	const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
	const aliases = {
		"@earendil-works/pi-coding-agent": join(base, "index.js"),
		"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
	};
	if (variant === "baseline" && !baseline) throw new Error("Set FILECHANGES_BENCH_BASELINE for the baseline worker");
	const source = join(variant === "baseline" ? baseline! : candidate, "filechanges.ts");
	const fixtureParent = join(homedir(), ".cache");
	await mkdir(fixtureParent, { recursive: true });
	const fixture = realpathSync(await mkdtemp(join(fixtureParent, "filechanges-bench-")));
	const excluded = join(fixture, "excluded-tmp");
	await mkdir(excluded);
	let extension: any;
	let rendererExtension: any;
	let setTmp: Function | undefined;
	const registryKey = Symbol.for("pi.filechanges.tracker");
	const mockKey = Symbol.for("pi.filechanges.benchmark.renderer-tracker");
	let cleanupPromise: Promise<void> | undefined;
	function cleanup(): Promise<void> {
		return cleanupPromise ??= (async () => {
			setTmp?.(null);
			delete (globalThis as any)[mockKey]; removeTracker(); active = undefined;
			await Promise.all([...children].map((child) => new Promise<void>((done) => {
				child.once("close", () => done()); child.kill("SIGKILL");
			})));
			(childProcess as any).execFile = originalExecFile; syncBuiltinESMExports();
			await rm(fixture, { recursive: true, force: true });
		})();
	}
	const stop = () => { void cleanup().finally(() => process.exit(124)); };
	process.once("SIGTERM", stop);
	const deadline = setTimeout(() => { process.stderr.write("Worker deadline exceeded\n"); stop(); }, Math.max(1000, timeoutMs - 1000));
	deadline.unref();
	function measureSync(suite: string, scenario: string, items: number, sample: number, operations: number, run: () => void): Row {
		const subprocesses: Record<string, number> = {};
		const rss0 = process.memoryUsage().rss;
		const cpu0 = process.cpuUsage();
		const start = performance.now();
		active = subprocesses;
		try { run(); } finally { active = undefined; }
		const wall = (performance.now() - start) * 1000;
		const cpu = process.cpuUsage(cpu0);
		const row = { variant, trial, suite, scenario, items, sample, operations, wall_us: wall / operations,
			cpu_us: (cpu.user + cpu.system) / operations, user_us: cpu.user / operations, system_us: cpu.system / operations,
			exec_file_calls: Object.values(subprocesses).reduce((sum, count) => sum + count, 0), subprocesses,
			rss_before_bytes: rss0, rss_after_bytes: process.memoryUsage().rss };
		rows.push(row); return row;
	}
	async function measure(suite: string, scenario: string, items: number, sample: number, run: () => Promise<void>): Promise<Row> {
		const subprocesses: Record<string, number> = {};
		const rss0 = process.memoryUsage().rss;
		const cpu0 = process.cpuUsage();
		const start = performance.now();
		active = subprocesses;
		try { await run(); } finally { active = undefined; }
		const wall = (performance.now() - start) * 1000;
		const cpu = process.cpuUsage(cpu0);
		const row = { variant, trial, suite, scenario, items, sample, operations: 1, wall_us: wall,
			cpu_us: cpu.user + cpu.system, user_us: cpu.user, system_us: cpu.system,
			exec_file_calls: Object.values(subprocesses).reduce((sum, count) => sum + count, 0), subprocesses,
			rss_before_bytes: rss0, rss_after_bytes: process.memoryUsage().rss };
		rows.push(row); return row;
	}
	class MockPi {
		handlers: Record<string, Function[]> = {};
		commands: Record<string, any> = {};
		appended: any[] = [];
		on(name: string, fn: Function) { (this.handlers[name] ??= []).push(fn); }
		registerCommand(name: string, def: any) { this.commands[name] = def; }
		appendEntry(customType: string, data: any) { this.appended.push({ type: "custom", customType, data }); }
		async fire(name: string, event: any, ctx: any) { for (const fn of this.handlers[name] ?? []) await fn(event, ctx); }
	}
	let sessionId = 0;
	function context(cwd: string, branch: any[] = []) {
		const id = `benchmark-${variant}-${trial}-${sessionId++}`;
		const ctx: any = { cwd, mode: "tui", hasUI: true, widget: undefined, widgetSets: 0, renderRequests: 0,
			sessionManager: { getSessionId: () => id, getBranch: () => branch }, waitForIdle: async () => {},
			ui: { theme, notify() {}, setStatus() {}, setWidget(_key: string, content: any) {
				ctx.widget?.dispose?.(); ctx.widgetSets++;
				if (Array.isArray(content)) {
					const container = new Container();
					for (const line of content.slice(0, 10)) container.addChild(new Text(line, 1, 0));
					if (content.length > 10) container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
					ctx.widget = container;
				} else if (typeof content === "function") ctx.widget = content({ requestRender() { ctx.renderRequests++; } }, theme);
				else ctx.widget = undefined;
				ctx.renderRequests++;
			} },
		};
		return ctx;
	}
	function items(n: number, cwd: string) {
		return Object.freeze(Array.from({ length: n }, (_, i) => Object.freeze({ path: `src/long-directory-${i}/module-${i}.ts`,
			absPath: join(cwd, `src/long-directory-${i}/module-${i}.ts`), absolutePath: join(cwd, `src/long-directory-${i}/module-${i}.ts`),
			kind: i % 3 === 0 ? "created" : "modified", added: i + 1, removed: i % 5,
			binary: i % 11 === 10, updatedAt: n - i, repoState: i % 7 === 0 ? "conflicted" : "unstaged", touchedThisPrompt: i % 2 === 0 })));
	}
	function removeTracker() { delete (globalThis as any)[registryKey]; }
	async function makeHarness(cwd: string, branch: any[] = []) {
		removeTracker();
		const pi = new MockPi();
		const ctx = context(cwd, branch);
		if (extension) await extension.default(pi);
		return { pi, ctx };
	}
	async function dispose(pi: MockPi, ctx: any) {
		await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		ctx.widget?.dispose?.(); ctx.widget = undefined;
		removeTracker();
	}
	async function hook(pi: MockPi, ctx: any, scenario: string, n: number, sample: number, eventName: string, event: any) {
		const sets = ctx.widgetSets, requests = ctx.renderRequests, appended = pi.appended.length;
		const row = await measure("hook", `${scenario}:${eventName}`, n, sample, () => pi.fire(eventName, event, ctx));
		row.widget_sets = ctx.widgetSets - sets; row.render_requests = ctx.renderRequests - requests;
		row.appended = pi.appended.length - appended;
		return row;
	}
	async function prompt(pi: MockPi, ctx: any) {
		await pi.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "fixture", systemPrompt: "" }, ctx);
		await pi.fire("agent_start", { type: "agent_start" }, ctx);
	}
	const original = Array.from({ length: 256 }, (_, i) => `line ${i}: stable source content\n`).join("");
	const changed = (i: number) => original + `change ${i}\n`;
	async function git(cwd: string, argv: string[]) {
		await exec("git", ["-c", "core.hooksPath=/dev/null", ...argv], { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	}
	async function repo(name: string, n: number): Promise<string> {
		const cwd = join(fixture, name); await mkdir(cwd);
		await git(cwd, ["init", "--quiet"]);
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ filechanges: { ignore: [] } }));
		for (let i = 0; i < n; i++) await writeFile(join(cwd, `file-${i}.txt`), original);
		await git(cwd, ["add", "."]);
		await git(cwd, ["-c", "user.email=bench@example.invalid", "-c", "user.name=Benchmark", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
		return cwd;
	}
	try {
		await measure("load", "extension-only", 0, 0, async () => {
			if (variant !== "bare") extension = await createJiti(import.meta.url, { alias: aliases, fsCache: false, moduleCache: false }).import(source);
		});
		setTmp = extension?.__setTmpRootsForTest;
		if (extension && !setTmp) throw new Error("Missing __setTmpRootsForTest seam");
		setTmp?.([excluded]);
		if (extension) {
			const mock = join(root, "scripts/bench-filechanges-renderer-mock.ts");
			rendererExtension = await createJiti(import.meta.url, { alias: { ...aliases,
				"./filechanges-tracker.ts": mock, [join(dirname(source), "filechanges-tracker.ts")]: mock }, fsCache: false, moduleCache: false }).import(source);
		}
		// Real factory for both UIs, but no tracker filesystem/Git work in renderer tests.
		for (const n of sizes) {
			const ctx = context(fixture);
			const snapshots = [items(n, fixture), items(n, fixture)];
			let snapshot = snapshots[0];
			let subscriber: Function = () => {};
			(globalThis as any)[mockKey] = { getContext: () => ctx, getChanges: () => snapshot, getMode: () => "all",
				isWidgetSuppressed: () => false, subscribe(fn: Function) { subscriber = fn; return () => {}; } };
			const pi = new MockPi();
			if (rendererExtension) await rendererExtension.default(pi);
			subscriber();
			if (variant === "candidate" && (!(ctx.widget instanceof rendererExtension.FileChangesPanel) ||
				typeof ctx.widget.setItems !== "function")) throw new Error("Candidate factory did not use FileChangesPanel");
			const container = new Container();
			if (ctx.widget) container.addChild(ctx.widget);
			if (variant !== "bare" && !ctx.widget) throw new Error(`Factory failed to create ${variant} renderer`);
			const render = (width: number) => container.render(width);
			for (const scenario of ["cached", "invalidated", "resize", "publish-render"]) {
				const run = (i: number) => {
					if (scenario === "invalidated") container.invalidate();
					if (scenario === "publish-render") {
						snapshot = snapshots[i % snapshots.length];
						subscriber(); container.clear(); if (ctx.widget) container.addChild(ctx.widget);
					}
					return render(scenario === "resize" ? widths[i % widths.length] : 80);
				};
				for (let i = 0; i < 100; i++) run(i);
				let output: string[] = [];
				const row = measureSync("renderer", scenario, n, 0, iterations, () => { for (let i = 0; i < iterations; i++) output = run(i); });
				row.lines = output.length;
				if (row.exec_file_calls) throw new Error("Renderer launched a subprocess");
				if (variant !== "bare") {
					if (!stripTerminalSequences(output.join("\n")).includes("Session changes")) throw new Error("Renderer snapshot was not published");
					for (const width of widths) if (render(width).some((line: string) => visibleWidth(line) > width)) throw new Error(`Renderer exceeded width ${width}`);
				}
			}
			await dispose(pi, ctx); delete (globalThis as any)[mockKey];
		}
		// Physical width fixture, not a timing workload. Logical widget limits do not
		// bound the old Text children's wrapped height. Include the actual factory.
		{
			const ctx = context(fixture);
			const snapshot = Object.freeze(items(20, fixture).map((item, i) => {
				const path = `src/${"very-long-directory/".repeat(8)}module-${i}.ts`;
				return Object.freeze({ ...item, path, absPath: join(fixture, path), absolutePath: join(fixture, path) });
			}));
			let subscriber: Function = () => {};
			(globalThis as any)[mockKey] = { getContext: () => ctx, getChanges: () => snapshot, getMode: () => "all",
				isWidgetSuppressed: () => false, subscribe(fn: Function) { subscriber = fn; return () => {}; } };
			const pi = new MockPi();
			if (rendererExtension) await rendererExtension.default(pi);
			subscriber();
			for (const width of widths) {
				const output: string[] = ctx.widget?.render(width) ?? [];
				const columns = output.map((line) => visibleWidth(line));
				if (columns.some((columns) => columns > width)) throw new Error(`Long-path fixture exceeded width ${width}`);
				if (variant === "candidate" && (output.length !== 8 || !stripTerminalSequences(output.join("\n")).includes("14 more"))) throw new Error("Candidate long-path Panel must use exactly eight physical rows with overflow");
				if (variant === "baseline" && output.length <= 10) throw new Error("Long-path fixture did not exercise baseline wrapping");
				if (variant === "bare" && output.length) throw new Error("Bare long-path fixture painted a Panel");
				layoutFixtures.push({ fixture: "long-path-physical-width", variant, trial, items: snapshot.length, width,
					physical_lines: output.length, max_columns: Math.max(0, ...columns), path_columns: visibleWidth(snapshot[0].path),
					file_row_budget: variant === "candidate" ? 4 : variant === "baseline" ? 8 : 0 });
			}
			await dispose(pi, ctx); delete (globalThis as any)[mockKey];
		}
		// A live Zen component is a reference row, not part of filechanges comparisons.
		const zen = await createJiti(import.meta.url, { alias: aliases }).import(zenPath);
		let reset: Function = () => {};
		zen.default({ registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerToolRenderer() {}, getFlag(name: string) { return name === "zen"; },
			on(name: string, fn: Function) { if (name === "session_start") reset = fn; } });
		reset({}, {});
		const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js");
		const { readRenderers } = await load("core/tools/renderers/read.js");
		const tool = new ToolExecutionComponent("read", "reference", { path: join(fixture, "reference.ts") }, { showImages: false, outputPad: 1 },
			zen.makeResolver(() => true)("read", () => readRenderers), { requestRender() {} }, fixture);
		tool.setArgsComplete(); tool.updateResult({ content: [{ type: "text", text: "source\n" }], details: {}, isError: false, durationMs: 10 }, false);
		for (const scenario of ["cached", "invalidated", "resize"]) {
			const run = (i: number) => { if (scenario === "invalidated") tool.invalidate(); return tool.render(scenario === "resize" ? widths[i % widths.length] : 80); };
			for (let i = 0; i < 100; i++) run(i);
			const row = measureSync("zen-reference", scenario, 1, 0, iterations, () => { for (let i = 0; i < iterations; i++) run(i); });
			row.lines = tool.render(80).length;
		}
		tool.dispose?.(); reset({}, {});

		const cwd = await repo("hooks", restoreItems);
		let h = await makeHarness(cwd);
		await hook(h.pi, h.ctx, "startup-empty", 0, 0, "session_start", { type: "session_start" });
		if (h.ctx.widget) throw new Error("Empty startup painted a panel");
		await dispose(h.pi, h.ctx);
		const restored = Array.from({ length: restoreItems }, (_, i) => ({ path: `file-${i}.txt`, absPath: join(cwd, `file-${i}.txt`),
			kind: "modified", added: 1, removed: 0, binary: false, updatedAt: restoreItems - i, touchedThisPrompt: true }));
		for (const item of restored) await writeFile(item.absPath, changed(0));
		h = await makeHarness(cwd, [{ type: "custom", customType: "filechanges:session-set", data: { items: restored, round: restored.map((item) => item.path), mode: "all", timestamp: 1 } }]);
		await hook(h.pi, h.ctx, "startup-restore", restoreItems, 0, "session_start", { type: "session_start" });
		if (extension && !h.ctx.widget?.render(80).join("\n").includes("Session changes")) throw new Error("Restore did not paint fixture changes");
		for (let i = 0; i < hookIterations; i++) {
			await hook(h.pi, h.ctx, "no-edit-prompt", restoreItems, i, "before_agent_start",
				{ type: "before_agent_start", messageType: "user", prompt: "answer only", systemPrompt: "" });
			await hook(h.pi, h.ctx, "no-edit-prompt", restoreItems, i, "agent_start", { type: "agent_start" });
			await hook(h.pi, h.ctx, "no-edit-prompt", restoreItems, i, "agent_settled", { type: "agent_settled" });
		}
		await dispose(h.pi, h.ctx);
		for (let i = 0; i < restoreItems; i++) await writeFile(join(cwd, `file-${i}.txt`), original);
		// Fresh trackers per workload. Unrelated dirty files are not silently included.
		for (const scenario of ["edit-repeated", "edit-noop", "bash-read-only", "bash-read-only-tracked", "bash-mutation"]) {
			await writeFile(join(cwd, "file-0.txt"), original);
			h = await makeHarness(cwd);
			await h.pi.fire("session_start", { type: "session_start" }, h.ctx); await prompt(h.pi, h.ctx);
			if (scenario === "edit-noop" || scenario === "bash-read-only-tracked") {
				await h.pi.fire("tool_call", { toolName: "edit", input: { path: "file-0.txt" }, toolCallId: "prime" }, h.ctx);
				await writeFile(join(cwd, "file-0.txt"), changed(0));
				await h.pi.fire("tool_result", { toolName: "edit", toolCallId: "prime", isError: false }, h.ctx);
				await h.pi.fire("tool_execution_end", { type: "tool_execution_end", toolName: "edit", toolCallId: "prime", isError: false,
					durationMs: 1, result: { content: [{ type: "text", text: "ok" }], details: {} } }, h.ctx);
				await h.pi.fire("agent_settled", { type: "agent_settled" }, h.ctx);
			}
			for (let i = 0; i < hookIterations; i++) {
				const isBash = scenario.startsWith("bash");
				const command = scenario.startsWith("bash-read-only") ? "git status --porcelain" : `printf 'change ${i + 1}\\n' >> file-0.txt`;
				const toolName = isBash ? "bash" : "edit";
				const input = isBash ? { command } : { path: "file-0.txt", oldText: `change ${i}`, newText: `change ${i + 1}` };
				const id = `${scenario}-${i}`;
				await hook(h.pi, h.ctx, scenario, 1, i, "tool_call", { type: "tool_call", toolName, input, toolCallId: id });
				// Tool body intentionally outside hook timers and exec counters.
				if (isBash) await exec("/bin/sh", ["-c", command], { cwd });
				else if (scenario === "edit-repeated") await writeFile(join(cwd, "file-0.txt"), changed(i + 1));
				else await readFile(join(cwd, "file-0.txt"));
				await hook(h.pi, h.ctx, scenario, 1, i, "tool_result", { type: "tool_result", toolName, input, toolCallId: id, isError: false, content: [{ type: "text", text: "ok" }], details: {} });
				const end = await hook(h.pi, h.ctx, scenario, 1, i, "tool_execution_end", { type: "tool_execution_end", toolName, args: input,
					toolCallId: id, isError: false, durationMs: 1, result: { content: [{ type: "text", text: "ok" }], details: {} } });
				if (end.exec_file_calls) throw new Error(`${scenario} normal execution-end launched a subprocess after result reconciliation`);
				if (end.widget_sets || end.render_requests || end.appended) throw new Error(`${scenario} normal execution-end duplicated a state change`);
				await hook(h.pi, h.ctx, scenario, 1, i, "agent_settled", { type: "agent_settled" });
				if (extension && scenario !== "bash-read-only" && !h.ctx.widget?.render(80).join("\n").includes("file-0.txt")) throw new Error(`${scenario} did not track the mutation`);
				if (scenario === "bash-read-only" && h.ctx.widget) throw new Error("Read-only Bash was attributed as a change");
				await hook(h.pi, h.ctx, "settle-clean", 1, i, "agent_settled", { type: "agent_settled" });
			}
			await dispose(h.pi, h.ctx);
		}
		// Prove the instrumentation observed the real baseline launches.
		if (variant === "baseline" && !rows.some((row) => row.suite === "hook" && row.exec_file_calls > 0)) throw new Error("execFile instrumentation missed tracker subprocesses");
	} finally {
		clearTimeout(deadline);
		process.removeListener("SIGTERM", stop);
		await cleanup();
	}
	console.log(JSON.stringify({ variant, trial, runtime: process.version, pi: version,
		rss_final_bytes: process.memoryUsage().rss, max_rss_bytes: process.resourceUsage().maxRSS * 1024,
		layout_fixtures: layoutFixtures, rows }));
}
