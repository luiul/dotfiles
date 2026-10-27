// Run: bun scripts/test-status-bar-resources.ts [--baseline /tmp/.../status-bar.ts]
// The VM runs the real extension with mocked Pi events, UI, git and virtual time.
// No Pi sessions or child processes start. Build output stays in memory.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Script, createContext } from "node:vm";

const require = createRequire(import.meta.url);
const sourcePath = resolve(import.meta.dir, "../pi/.pi/agent/extensions/status-bar.ts");
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
const colors: Record<string, number> = { text: 255, accent: 141, muted: 250, dim: 240, warning: 220, error: 196, success: 82 };
const colorText = (color: string, text: string) => `\x1b[38;5;${colors[color]}m${text}\x1b[0m`;
function styledCells(text: string) {
	let color: number | undefined;
	let bold = false;
	const cells: { text: string; color?: number; bold: boolean }[] = [];
	for (const match of text.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/g)) {
		if (match[1] !== undefined) {
			const codes = (match[1] || "0").split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				if (codes[i] === 0) { color = undefined; bold = false; }
				else if (codes[i] === 1) bold = true;
				else if (codes[i] === 22) bold = false;
				else if (codes[i] === 38 && codes[i + 1] === 5) { color = codes[i + 2]; i += 2; }
			}
		} else cells.push({ text: match[2], color, bold });
	}
	return cells;
}
function assertStyle(row: string, text: string, color: string, bold = false) {
	const cells = styledCells(row);
	const start = cells.map(c => c.text).join("").indexOf(text);
	assert.ok(start >= 0, `Missing styled text: ${text}`);
	assert.ok(cells.slice(start, start + text.length).every(c => c.color === colors[color] && c.bold === bold), `Wrong ${color}/${bold ? "bold" : "normal"} style: ${text}`);
}
let checks = 0;
function check(name: string, fn: () => void) {
	fn();
	checks++;
	console.log(`ok ${name}`);
}

async function compile(path: string) {
	const result = await Bun.build({ entrypoints: [path], target: "node", format: "cjs", external: ["*"], write: false });
	assert.equal(result.success, true, result.logs.join("\n"));
	return result.outputs[0].text();
}

function harness(code: string) {
	let now = 0;
	let id = 0;
	const timers = new Map<number, { callback: () => void; at: number; interval?: number; unref: boolean }>();
	const addTimer = (callback: () => void, delay: number, interval?: number) => {
		const key = ++id;
		const timer = { callback, at: now + delay, interval, unref: false };
		timers.set(key, timer);
		return { key, unref: () => { timer.unref = true; } };
	};
	const clearTimer = (handle: any) => { timers.delete(handle?.key); };
	const setInterval = (callback: () => void, delay: number) => addTimer(callback, delay, delay);
	const setTimeout = (callback: () => void, delay: number) => addTimer(callback, delay);
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const calls: { cwd: string; timeout: number; args: string[]; complete: (stdout?: string, error?: Error) => void; done: boolean }[] = [];
	const reads: string[] = [];
	const copies: string[] = [];
	let copyError = false;
	let saved = true;
	let gitIdentity = "/repo/one\n/repo/one/.git\n/repo/one/.git\n";
	let compactionEnabled = true;
	let holdGit = false;
	let running = 0;
	let maxRunning = 0;
	let gitOutput = "# branch.ab +2 -3\n1 .M file\n? new\n";
	const execFile = (command: string, args: string[], options: any, callback: Function) => {
		assert.equal(command, "git");
		running++;
		maxRunning = Math.max(maxRunning, running);
		let timeout: any;
		const call = {
			cwd: options.cwd, timeout: options.timeout, args, done: false,
			complete: (stdout = args[0] === "rev-parse" ? gitIdentity : gitOutput, error?: Error) => {
				if (call.done) return;
				call.done = true;
				running--;
				clearTimer(timeout);
				callback(error ?? null, stdout, "");
			},
		};
		calls.push(call);
		timeout = setTimeout(() => call.complete("", new Error("git timeout")), options.timeout);
		if (!holdGit) queueMicrotask(() => call.complete());
		return {};
	};
	// Node execFile's custom promisifier resolves both stdout and stderr.
	(execFile as any)[promisify.custom] = (command: string, args: string[], options: any) =>
		new Promise((resolve, reject) => execFile(command, args, options, (error: Error | null, stdout: string, stderr: string) =>
			error ? reject(error) : resolve({ stdout, stderr })));
	class ClockDate extends Date {
		static now() { return now; }
	}
	const module = { exports: {} as any };
	new Script(code).runInContext(createContext({
		module, exports: module.exports, console, Date: ClockDate,
		setInterval, clearInterval: clearTimer, setTimeout, clearTimeout: clearTimer,
		require: (name: string) => {
			if (name === "node:child_process") return { execFile };
			if (name === "@earendil-works/pi-coding-agent") return { copyToClipboard: async (text: string) => {
				if (copyError) throw new Error("Clipboard unavailable");
				copies.push(text);
			} };
			if (name === "node:fs") return { existsSync: () => saved, readFileSync: (path: string) => {
				reads.push(path);
				return JSON.stringify({ compaction: { enabled: compactionEnabled, reserveTokens: 16384 } });
			} };
			return require(name);
		},
	}));
	module.exports.default({
		on: (name: string, fn: Function) => { handlers.set(name, fn); },
		registerCommand: (name: string, command: any) => { commands.set(name, command); },
		getThinkingLevel: () => "high",
	});

	const context = (mode = "tui", hasUI = true, cwd = "/repo/one") => {
		const subscribers = new Set<() => void>();
		const history: any[] = [];
		const notices: string[] = [];
		let footer: any;
		let renders = 0;
		let footerSets = 0;
		const statuses = new Map([["meter", "plain status"]]);
		const theme = {
			fg: colorText,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
			getThinkingBorderColor: () => (text: string) => text,
		};
		const state = {
			ctx: {
				mode, hasUI, cwd,
				ui: {
					setFooter: (factory?: Function) => {
						footerSets++;
						// Headless and RPC UIs cannot construct terminal components.
						if (mode !== "tui" || !hasUI) return;
						footer?.dispose();
						footer = factory?.({ requestRender: () => { renders++; } }, theme, {
							getGitBranch: () => state.branchLabel,
							getExtensionStatuses: () => statuses,
							onBranchChange: (fn: () => void) => {
								subscribers.add(fn);
								history.push(fn);
								return () => { subscribers.delete(fn); };
							},
						});
					},
					notify: (text: string) => { notices.push(text); },
				},
				sessionManager: {
					getLeafId: () => "active-leaf",
					getSessionId: () => "12345678-abcd-4321-8765-0123456789ab",
					getSessionFile: (): string | undefined => "/sessions/test.jsonl",
					getSessionName: () => "test session",
					getBranch: () => [{ type: "message", message: {
						role: "assistant", stopReason: "stop",
						usage: { input: 1000, output: 2000, cacheRead: 4000, cacheWrite: 100, cost: { total: 0.123 } },
					} }],
				},
				model: { id: "model-id", name: "Model Name", provider: "router" },
				getContextUsage: () => ({ tokens: 30000, contextWindow: 128000, percent: 23.4375 }),
			},
			subscribers, history, notices, statuses, theme, branchLabel: "main",
			get footer() { return footer; },
			get renders() { return renders; },
			get footerSets() { return footerSets; },
			branch: () => { for (const fn of subscribers) fn(); },
		};
		return state;
	};
	return {
		calls, reads, copies, context, timers,
		set copyError(value: boolean) { copyError = value; },
		set saved(value: boolean) { saved = value; },
		set identity(value: string) { gitIdentity = value; },
		set compactionEnabled(value: boolean) { compactionEnabled = value; },
		set hold(value: boolean) { holdGit = value; },
		set output(value: string) { gitOutput = value; },
		get maxRunning() { return maxRunning; },
		intervals: () => [...timers.values()].filter(t => t.interval !== undefined).map(t => t.interval).sort(),
		fire: async (name: string, state: ReturnType<typeof context>) => { await handlers.get(name)?.({}, state.ctx); await flush(); },
		command: async (name: string, state: ReturnType<typeof context>) => { await commands.get(name).handler("", state.ctx); await flush(); },
		toggle: async (state: ReturnType<typeof context>) => { await commands.get("statusbar").handler("", state.ctx); await flush(); },
		advance: async (ms: number) => {
			const target = now + ms;
			await flush();
			while (true) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!due) break;
				const [key, timer] = due;
				now = timer.at;
				if (timer.interval !== undefined) timer.at += timer.interval;
				else timers.delete(key);
				timer.callback();
				await flush();
			}
			now = target;
			await flush();
		},
	};
}

const { visibleWidth } = require("@earendil-works/pi-tui");
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const code = await compile(sourcePath);
const baselineArg = process.argv.indexOf("--baseline");
const baselineCode = baselineArg >= 0 ? await compile(resolve(process.argv[baselineArg + 1])) : undefined;

async function measure(compiled: string, mode: string, hasUI: boolean) {
	const h = harness(compiled);
	const state = h.context(mode === "sdk" ? "print" : mode, hasUI);
	await h.fire("session_start", state);
	await h.advance(12000);
	const result = { git: h.calls.length, reads: h.reads.length, intervals: h.intervals().length, renders: state.renders };
	await h.fire("session_shutdown", state);
	state.footer?.dispose();
	return result;
}

for (const [mode, hasUI] of [["sdk", false], ["rpc", true], ["json", false], ["print", false], ["tui", false]] as const) {
	const h = harness(code);
	// SDK contexts default to print mode in Pi's extension runner.
	const state = h.context(mode === "sdk" ? "print" : mode, hasUI);
	await h.fire("session_start", state);
	await h.fire("before_agent_start", state);
	await h.advance(12000);
	await h.toggle(state);
	await h.toggle(state);
	await h.fire("agent_settled", state);
	await h.fire("session_start", state);
	await h.fire("session_shutdown", state);
	await h.command("session-ref", state);
	check(`${mode} hasUI=${hasUI} has no footer resources or settings reads`, () => {
		assert.equal(h.calls.length, 0);
		assert.equal(h.reads.length, 0);
		assert.equal(h.timers.size, 0);
		assert.equal(state.footerSets, 0);
		assert.equal(state.renders, 0);
		assert.equal(h.copies.length, 0);
		assert.equal(state.notices.length, 0);
	});
	if (mode === "sdk" || mode === "rpc") {
		const after = await measure(code, mode, hasUI);
		const before = baselineCode ? await measure(baselineCode, mode, hasUI) : undefined;
		console.log(`12s mock ${mode}: baseline=${before ? JSON.stringify(before) : "not supplied"} after=${JSON.stringify(after)}`);
		if (before) check(`${mode} measurement preserves zero headless resources`, () => {
			assert.equal(before.git, 0);
			assert.deepEqual(after, before);
		});
	}
}

{
	const h = harness(code);
	const state = h.context();
	check("factory creates no timers or git calls", () => { assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0); });
	await h.fire("session_start", state);
	check("TUI startup reads settings and uses only one 4s timer", () => {
		assert.equal(h.reads.length, 2);
		assert.deepEqual(h.intervals(), [4000]);
		assert.equal(state.subscribers.size, 1);
		assert.equal(state.renders, 1);
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[0].args.join(" "), "rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir");
	});
	await h.advance(12000);
	check("TUI retains startup plus three polls over 12s, rendering once per refresh", () => {
		assert.equal(h.calls.length, 5);
		assert.equal(state.renders, 4);
		assert.ok(h.calls.every(c => c.timeout === 2000));
		assert.ok(h.calls.slice(1).every(c => c.args.join(" ") === "status --porcelain=2 --branch"));
		assert.ok([...h.timers.values()].every(t => t.unref));
	});
	await h.fire("before_agent_start", state);
	await h.advance(3000);
	check("active TUI turn ticks at 1s and shows elapsed time", () => {
		assert.deepEqual(h.intervals(), [1000, 4000]);
		assert.ok(state.footer.render(160).join("\n").includes("3s"));
	});
	const oldCallback = state.history[0];
	await h.toggle(state);
	const disabledCalls = h.calls.length;
	const disabledRenders = state.renders;
	const disabledReads = h.reads.length;
	oldCallback();
	await h.advance(12000);
	check("disable clears both timers and branch listener, with no later work", () => {
		assert.equal(h.timers.size, 0);
		assert.equal(state.footer, undefined);
		assert.equal(state.subscribers.size, 0);
		assert.equal(h.calls.length, disabledCalls);
		assert.equal(state.renders, disabledRenders);
		assert.equal(h.reads.length, disabledReads);
	});
	await h.toggle(state);
	check("reenable mid-turn resumes both timers and keeps the original start time", () => {
		assert.deepEqual(h.intervals(), [1000, 4000]);
		assert.ok(state.footer.render(160).join("\n").includes("15s"));
	});
	await h.fire("agent_settled", state);
	check("settlement removes only the turn timer", () => {
		assert.deepEqual(h.intervals(), [4000]);
		assert.ok(!state.footer.render(160).join("\n").includes("working"));
	});
	await h.toggle(state);
	await h.fire("before_agent_start", state);
	await h.advance(2000);
	check("turn starting disabled does not create a timer", () => assert.equal(h.timers.size, 0));
	await h.toggle(state);
	check("enable during a turn that started disabled shows its real age", () => {
		assert.deepEqual(h.intervals(), [1000, 4000]);
		assert.ok(state.footer.render(160).join("\n").includes("2s"));
	});
	await h.fire("session_start", state);
	await h.fire("session_start", state);
	check("repeated startup replaces resources and resets turn state", () => {
		assert.deepEqual(h.intervals(), [4000]);
		assert.equal(state.subscribers.size, 1);
		assert.ok(!state.footer.render(160).join("\n").includes("working"));
	});
	await h.toggle(state);
	const count = h.calls.length;
	await h.fire("session_start", state);
	check("disabled repeated startup stays inactive", () => { assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0); });
	await h.toggle(state);
	await h.fire("before_agent_start", state);
	await h.fire("session_shutdown", state);
	await h.fire("session_shutdown", state);
	const shutdownCalls = h.calls.length;
	const shutdownRenders = state.renders;
	await h.advance(12000);
	check("shutdown is idempotent and releases all footer timers and listeners", () => {
		assert.equal(h.timers.size, 0);
		assert.equal(state.subscribers.size, 0);
		assert.equal(h.calls.length, shutdownCalls);
		assert.equal(state.renders, shutdownRenders);
	});
}

{
	const h = harness(code);
	const state = h.context();
	await h.fire("session_start", state);
	h.hold = true;
	state.branch();
	state.branch();
	state.branch();
	await h.advance(1000);
	check("branch refreshes coalesce while one git subprocess runs", () => assert.equal(h.calls.length, 3));
	h.calls[2].complete("# branch.ab +5 -6\n? only\n");
	await flush();
	check("one queued refresh runs after completion without overlap", () => { assert.equal(h.calls.length, 4); assert.equal(h.maxRunning, 1); });
	h.calls[3].complete("# branch.ab +5 -6\n? only\n");
	await flush();
	check("parsed git state still renders changed, ahead and behind", () => {
		const text = strip(state.footer.render(160).join("\n"));
		assert.ok(text.includes("changed 1") && text.includes("ahead 5") && text.includes("behind 6"));
	});
	state.branch();
	await h.advance(2000);
	check("git timeout clears current counts and never overlaps", () => {
		assert.equal(h.maxRunning, 1);
		assert.ok(!state.footer.render(160).join("\n").includes("changed"));
	});
	await h.fire("session_shutdown", state);
}

for (const transition of ["disable", "reenable", "replace", "headless", "shutdown"] as const) {
	const h = harness(code);
	h.hold = true;
	const old = h.context();
	await h.fire("session_start", old);
	const oldCallback = old.history[0];
	old.branch();
	let next = old;
	if (transition === "disable" || transition === "reenable") await h.toggle(old);
	if (transition === "reenable") await h.toggle(old);
	if (transition === "replace" || transition === "headless") {
		next = h.context(transition === "headless" ? "rpc" : "tui", true, "/repo/two");
		await h.fire("session_start", next);
	}
	if (transition === "shutdown") await h.fire("session_shutdown", old);
	const oldRenders = old.renders;
	const nextRenders = next.renders;
	if (transition !== "reenable") {
		// Pi's context getters throw once the old extension runtime is invalid.
		Object.defineProperty(old.ctx, "mode", { get: () => { throw new Error("stale context accessed"); } });
	}
	oldCallback();
	h.calls[0].complete("# branch.ab +99 -99\n? stale\n");
	await flush();
	check(`${transition} rejects stale git completion and detached branch callbacks`, () => {
		assert.equal(old.renders, oldRenders);
		assert.equal(next.renders, nextRenders);
		assert.equal(h.maxRunning, 1);
		assert.equal(old.subscribers.size, transition === "reenable" ? 1 : 0);
		if (transition === "replace" || transition === "reenable") {
			assert.equal(h.calls.length, 2);
			assert.equal(h.calls[1].cwd, next.ctx.cwd);
			assert.ok(!next.footer.render(160).join("\n").includes("99"));
		} else {
			assert.equal(h.calls.length, 1);
			assert.equal(h.timers.size, 0);
		}
	});
	if (transition === "replace" || transition === "reenable") {
		h.calls[1].complete("/repo/two\n/repo/two/.git\n/repo/two/.git\n");
		await flush();
		h.calls[2].complete("# branch.ab +1 -0\n? fresh\n");
		await flush();
		check(`${transition} renders only the fresh generation`, () => {
			assert.equal(next.renders, nextRenders + 1);
			assert.ok(strip(next.footer.render(160).join("\n")).includes("changed 1"));
		});
	}
	await h.fire("session_shutdown", next);
	await h.advance(12000);
	assert.equal(h.timers.size, 0);
}

if (baselineCode) {
	const baseline = harness(baselineCode);
	const current = harness(code);
	const b = baseline.context();
	const c = current.context();
	await baseline.fire("session_start", b);
	await current.fire("session_start", c);
	check("styling changes without changing baseline layout or visible content", () => {
		assert.equal(c.footer.render(120).length, 3);
		assert.equal(c.footer.render(60).length, 4);
		assert.notEqual(JSON.stringify(c.footer.render(120)), JSON.stringify(b.footer.render(120)));
		for (const width of [0, 1, 20, 36, 44, 60, 79, 80, 100, 139, 140, 160, 200]) {
			assert.deepEqual(c.footer.render(width).map(strip), b.footer.render(width).map(strip), `Visible layout changed at ${width}`);
		}
	});
	await baseline.fire("before_agent_start", b);
	await current.fire("before_agent_start", c);
	await baseline.advance(12000);
	await current.advance(12000);
	check("TUI status polling cadence and timer count match baseline", () => {
		assert.equal(current.calls.filter(c => c.args[0] === "status").length, baseline.calls.filter(c => c.args[0] === "status").length);
		assert.equal(current.calls.filter(c => c.args[0] === "status").length, 4);
		assert.equal(current.intervals().length, baseline.intervals().length);
	});
	await baseline.fire("session_shutdown", b);
	await current.fire("session_shutdown", c);
	b.footer.dispose();
}
{
	const h = harness(code);
	h.identity = "/worktrees/luiul/improve-status-bar/dotfiles\n/home/luis/dotfiles/.git\n/home/luis/dotfiles/.git/worktrees/dotfiles2\n";
	const state = h.context();
	state.ctx.model = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "ai-model-router" };
	await h.fire("session_start", state);
	const text = (width: number) => strip(state.footer.render(width).join("\n"));
	check("wide footer groups checkout, runtime and session identity in three rows", () => {
		const rows = state.footer.render(200).map(strip);
		assert.equal(rows.length, 3);
		assert.ok(rows[0].includes("dotfiles  worktree improve-status-bar  branch main"));
		assert.match(rows[0], / {2,}changed 2  ahead 2  behind 3$/);
		assert.ok(rows[1].includes("GPT-6.1 Sol [ai-model-router]"));
		assert.ok(rows[1].includes("context 30k/128k") && rows[1].includes("until compact 82k"));
		assert.ok(rows[2].includes(state.ctx.sessionManager.getSessionId()));
		for (const metric of ["test session", "$0.123", "hit 80%", "in 1.0k", "out 2.0k", "cache 4.1k", "plain status"]) assert.ok(rows[2].includes(metric), metric);
		assert.ok(!text(200).includes("free "));
	});
	check("four narrow rows keep UUID, provider, context and timer before metrics", () => {
		assert.equal(state.footer.render(60).length, 4);
		assert.ok(text(60).includes("GPT-6.1 Sol [ai-model-router]"));
		assert.ok(text(60).includes("until compact 82k"));
		assert.ok(text(60).includes(state.ctx.sessionManager.getSessionId()));
	});
	check("left identities and right state stay anchored at wide widths", () => {
		for (const width of [80, 100, 120, 140, 160, 200]) {
			const rows = state.footer.render(width).map(strip);
			assert.ok(rows[0].startsWith("dotfiles"));
			assert.ok(rows[1].startsWith("GPT-6.1 Sol [ai-model-router]"), `${width}: ${rows[1]}`);
			assert.ok(rows[2].startsWith(`session ${state.ctx.sessionManager.getSessionId()}`));
			assert.ok(rows.every((row: string) => visibleWidth(row) === width), `${width}: ${rows.join("\n")}`);
			assert.match(rows[0], / {2,}changed 2  ahead 2  behind 3$/);
			assert.ok(rows[1].indexOf("context") > rows[1].indexOf("[ai-model-router]") + 17);
			assert.match(rows[2], / {2,}(plain status|\$0\.123)/);
		}
	});
	check("detail metrics stay out of compact and medium layouts", () => {
		for (const width of [36, 44, 60, 79, 80, 100, 120, 139]) {
			const rendered = text(width);
			assert.ok(!rendered.includes("in 1.0k") && !rendered.includes("out 2.0k") && !rendered.includes("cache 4.1k"));
			assert.ok(!rendered.includes("[██"));
		}
		assert.ok(text(200).includes("in 1.0k") && text(200).includes("[██"));
	});
	check("narrow groups stay separate and keep the UUID on the final row", () => {
		const rows = state.footer.render(60).map(strip);
		assert.ok(rows[1].startsWith("GPT-6.1 Sol [ai-model-router]"));
		assert.match(rows[1], / {2,}thinking high$/);
		assert.ok(rows[2].startsWith("context 30k/128k"));
		assert.match(rows[2], / {2,}until compact 82k$/);
		assert.ok(rows[3].startsWith(`session ${state.ctx.sessionManager.getSessionId()}`));
	});
	await h.fire("before_agent_start", state);
	await h.advance(3000);
	check("working timer and headroom survive crowded runtime rows", () => {
		for (const width of [36, 44, 60, 79, 80, 100]) {
			assert.ok(text(width).includes("working 3s"), `${width}: ${text(width)}`);
			assert.ok(text(width).includes("until compact 82k"), `${width}: ${text(width)}`);
		}
	});
	check("working timer stays at the right edge of the checkout row", () => {
		for (const width of [36, 44, 60, 79, 80, 100, 160, 200]) {
			const rows = state.footer.render(width).map(strip);
			assert.match(rows[0], /working 3s$/);
			assert.equal(visibleWidth(rows[0]), width);
			assert.ok(rows.slice(1).every((row: string) => !row.includes("working")));
		}
	});
	check("every row fits its terminal width and never silently shortens UUID", () => {
		for (const width of [0, 1, 10, 20, 35, 36, 43, 44, 45, 60, 79, 80, 100, 120, 160, 200]) {
			const rows = state.footer.render(width);
			assert.ok(rows.every((r: string) => visibleWidth(r) <= width), `width ${width}`);
			if (width >= 36) assert.ok(text(width).includes(state.ctx.sessionManager.getSessionId()), `width ${width}`);
			if (width > 0 && width < 36) assert.ok(rows.at(-1).includes("…"), `width ${width}`);
		}
	});
	check("long model names yield to the whole provider, headroom and timer", () => {
		state.ctx.model.name = "Very long model name ".repeat(12);
		const rendered = text(80);
		assert.ok(rendered.includes("[ai-model-router]") && rendered.includes("…"));
		assert.ok(rendered.includes("working 3s") && rendered.includes("until compact 82k"));
		state.ctx.model = { id: "eu.anthropic.claude-sonnet-4-6", name: "Sonnet", provider: "amazon-bedrock" };
		assert.ok(text(200).includes("eu.anthropic.claude-sonnet-4-6 [amazon-bedrock]"));
	});
	check("width fast-path does not retain theme or status text between renders", () => {
		const before = state.footer.render(200);
		const original = state.theme.fg;
		state.theme.fg = (_color: string, value: string) => `\x1b[38;5;123m${value}\x1b[0m`;
		state.footer.invalidate();
		const after = state.footer.render(200);
		assert.notEqual(after.join("\n"), before.join("\n"));
		assert.deepEqual(after.map(strip), before.map(strip));
		state.statuses.set("meter", "changed status text");
		assert.ok(strip(state.footer.render(200).join("\n")).includes("changed status text"));
		state.theme.fg = original;
		state.statuses.set("meter", "plain status");
	});
	check("long model names keep thinking before visual context details", () => {
		const saved = state.ctx.model;
		state.ctx.model = { id: "long-model", name: "Very long model name ".repeat(40), provider: "ai-model-router" };
		for (const width of [90, 139, 140, 200]) {
			const rendered = text(width);
			assert.ok(rendered.includes("thinking high"), `${width}: ${rendered}`);
			assert.ok(rendered.includes("context 30k/128k") && rendered.includes("until compact 82k"));
			assert.ok(state.footer.render(width).every((r: string) => visibleWidth(r) <= width));
		}
		state.ctx.model = { id: "eu.anthropic.claude-sonnet-4-6", name: "Sonnet", provider: "amazon-bedrock" };
		assert.ok(text(90).includes("thinking high") && text(90).includes("[amazon-bedrock]"));
		state.ctx.model = saved;
	});
	check("narrow model identity wins over thinking when both cannot fit", () => {
		const saved = state.ctx.model;
		state.ctx.model = { id: "eu.anthropic.claude-sonnet-4-6", name: "Sonnet", provider: "amazon-bedrock" };
		for (const width of [20, 30, 31]) {
			const row = strip(state.footer.render(width)[1]);
			assert.ok(row.includes("…") && row.includes("[amazon-bedrock]"), `${width}: ${row}`);
			assert.ok(!row.includes("thinking"));
		}
		state.ctx.model = saved;
	});
	check("extremely narrow required rows show truncation rather than blanks", () => {
		for (const width of [1, 5, 9]) {
			const rows = state.footer.render(width).map(strip);
			assert.ok(rows.every((row: string) => row.length > 0 && visibleWidth(row) <= width));
			assert.ok(rows[1].includes("…") && rows[2].includes("…"));
		}
	});
	check("long providers shorten clearly across the 79/80 layout boundary", () => {
		const model = state.ctx.model;
		state.ctx.model = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "very-long-company-model-router" };
		for (const width of [36, 44, 60, 79, 80, 81, 85, 100]) {
			const rendered = text(width);
			assert.ok(/\[[^\]]+\]/.test(rendered), `${width}: ${rendered}`);
			assert.ok(rendered.includes("working 3s") && rendered.includes("until compact 82k"));
			assert.ok(state.footer.render(width).every((r: string) => visibleWidth(r) <= width));
			const row = state.footer.render(width)[1];
			const cells = styledCells(row);
			const start = cells.findIndex(c => c.text === "[");
			const end = cells.findIndex((c, i) => i > start && c.text === "]");
			assert.ok(start >= 0 && end > start);
			assert.ok(cells.slice(start, end + 1).every(c => c.color === colors.muted && !c.bold), `Long provider style at ${width}`);
		}
		assert.ok(text(80).includes("…"));
		state.ctx.model = model;
	});
	check("missing model has a clear fallback without a fake provider", () => {
		const saved = state.ctx.model;
		(state.ctx as any).model = undefined;
		assert.ok(text(200).includes("no model") && !text(200).includes("[amazon-bedrock]"));
		state.ctx.model = saved;
	});
	check("provider and session identity follow current context without restart", () => {
		state.ctx.sessionManager.getSessionId = () => "87654321-1234-4321-abcd-112233445566";
		assert.ok(text(80).includes("87654321-1234-4321-abcd-112233445566"));
		assert.ok(!text(200).includes("12345678-abcd"));
	});
	check("long session names yield to right-side status and cost", () => {
		const saved = state.ctx.sessionManager.getSessionName;
		state.ctx.sessionManager.getSessionName = () => "session-title-".repeat(100);
		const rows = state.footer.render(120).map(strip);
		assert.ok(rows[2].startsWith(`session ${state.ctx.sessionManager.getSessionId()}`));
		assert.ok(rows[2].includes("plain status") && rows[2].includes("$0.123") && rows[2].includes("hit 80%"));
		assert.equal(visibleWidth(rows[2]), 120);
		assert.ok(rows[2].includes("…"));
		state.ctx.sessionManager.getSessionName = saved;
	});
	check("long names, branch and Unicode paths do not hide protected fields", () => {
		state.ctx.sessionManager.getSessionName = () => "长名字🚀 ".repeat(60) + "\n\x1b[31minjected";
		state.branchLabel = "long-branch-".repeat(100);
		for (const width of [36, 44, 60, 80, 120, 200]) {
			const rows = state.footer.render(width);
			assert.ok(rows.every((r: string) => !r.includes("\n") && visibleWidth(r) <= width));
			assert.ok(text(width).includes("87654321-1234-4321-abcd-112233445566"));
			assert.ok(text(width).includes("working 3s"));
		}
	});
	check("extension colors survive without accepting terminal controls", () => {
		state.statuses.set("meter", "\x1b[31mbh\x1b[0m O\x1b[32m▕▏▏\x1b[0m\n\x1b[2J\x1b]52;c;secret\x07");
		const rows = state.footer.render(200);
		const raw = rows.join("\n");
		assert.ok(raw.includes("\x1b[31m") && strip(raw).includes("blackhole"));
		assert.ok(!raw.includes("\x1b[2J") && !raw.includes("secret"));
		assert.ok(rows.every((r: string) => !r.includes("\n")));
		state.statuses.set("meter", "plain status");
	});
	check("unknown context and unavailable context never claim compaction headroom", () => {
		(state.ctx as any).getContextUsage = () => ({ tokens: null, contextWindow: 128000, percent: null });
		assert.ok(text(200).includes("context unknown"));
		assert.ok(!text(200).includes("until compact"));
		(state.ctx as any).getContextUsage = () => undefined;
		assert.ok(text(200).includes("context unavailable"));
		assert.ok(!text(200).includes("until compact"));
	});
	check("context past the threshold clamps headroom to zero", () => {
		state.ctx.getContextUsage = () => ({ tokens: 120000, contextWindow: 128000, percent: 93.75 });
		assert.ok(text(200).includes("until compact 0"));
	});
	h.compactionEnabled = false;
	await h.fire("session_start", state);
	check("disabled auto compaction is explicit", () => {
		assert.ok(text(80).includes("auto compact off"));
		assert.ok(!text(200).includes("until compact"));
	});
	await h.fire("session_shutdown", state);
}

{
	const h = harness(code);
	const state = h.context();
	await h.fire("session_start", state);
	check("model is bold accent and checkout is bold neutral while metadata stays quiet", () => {
		const rows = state.footer.render(200);
		assertStyle(rows[0], "one", "text", true);
		assertStyle(rows[0], "main", "muted");
		assertStyle(rows[0], "2", "warning");
		assertStyle(rows[1], "Model Name", "accent", true);
		assertStyle(rows[1], " [router]", "muted");
		assertStyle(rows[2], state.ctx.sessionManager.getSessionId(), "muted");
		for (const text of ["$0.123", "in 1.0k", "out 2.0k", "cache 4.1k"]) assertStyle(rows[2], text, "dim");
		assertStyle(rows[2], "80%", "success");
	});
	check("truncated models retain bold accent without leaking into the provider or context", () => {
		state.ctx.model = { id: "eu.anthropic.claude-sonnet-4-6", name: "Sonnet", provider: "amazon-bedrock" };
		for (const width of [20, 31, 36, 60, 79, 80, 90, 139, 140, 200]) {
			const row = state.footer.render(width)[1];
			const cells = styledCells(row);
			const bracket = cells.findIndex(c => c.text === "[");
			assert.ok(bracket > 0, `Missing provider at ${width}`);
			const end = cells.findIndex((c, i) => i >= bracket && c.text === "]");
			assert.ok(end > bracket);
			assert.ok(cells.slice(0, bracket).filter(c => c.text !== " ").every(c => c.color === colors.accent && c.bold), `Model styling at ${width}: ${JSON.stringify(row)}`);
			assert.ok(cells.slice(bracket, end + 1).every(c => c.color === colors.muted && !c.bold), `Provider styling at ${width}`);
			if (width >= 36) assertStyle(row, "eu.", "accent", true);
			if (strip(row).includes("context")) assertStyle(row, "context ", "dim");
		}
		state.ctx.model = { id: "model-id", name: "Model Name", provider: "router" };
	});
	check("cache reuse has neutral moderate values and green positive results", () => {
		for (const [hit, color] of [[0, "dim"], [49, "dim"], [50, "muted"], [79, "muted"], [80, "success"], [100, "success"]] as const) {
			state.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "assistant", stopReason: "stop",
				usage: { input: 100 - hit, output: 0, cacheRead: hit, cacheWrite: 0, cost: { total: 0 } } } }];
			assertStyle(state.footer.render(200)[2], `${hit}%`, color);
		}
	});
	check("context colors preserve compaction boundaries without accenting healthy usage", () => {
		for (const [tokens, color] of [[30000, "muted"], [74999, "muted"], [75000, "warning"], [94999, "warning"], [95000, "error"], [120000, "error"]] as const) {
			state.ctx.getContextUsage = () => ({ tokens, contextWindow: 116384, percent: tokens / 116384 * 100 });
			const row = state.footer.render(200)[1];
			const cells = styledCells(row);
			const text = strip(row);
			const start = text.indexOf("until compact ") + "until compact ".length;
			assert.equal(cells[start].color, colors[color], `Headroom at ${tokens}`);
			const fill = cells.filter(c => c.text === "█");
			assert.ok(fill.length > 0 && fill.every(c => c.color === colors[color]), `Context fill at ${tokens}`);
		}
	});
	await h.fire("before_agent_start", state);
	await h.advance(599999);
	check("working timer stays yellow before ten minutes", () => assertStyle(state.footer.render(200)[0], "9m", "warning"));
	await h.advance(1);
	check("working timer becomes red at ten minutes", () => assertStyle(state.footer.render(200)[0], "10m", "error"));
	await h.fire("agent_settled", state);
	check("settled footer has no working timer", () => assert.ok(!strip(state.footer.render(200)[0]).includes("working")));
	await h.fire("session_shutdown", state);
}

for (const identity of ["/repo/one\n/repo/one/.git\n/repo/one/.git\n", "/repo/linked\n/repo/main/.git\n/repo/main/.git/worktrees/linked\n"]) {
	const h = harness(code);
	h.identity = identity;
	const state = h.context("tui", true, identity.startsWith("/repo/linked") ? "/repo/linked/src" : "/repo/one");
	await h.fire("session_start", state);
	check(`checkout label resolves ${identity.startsWith("/repo/linked") ? "linked subdirectory" : "main checkout"}`, () => {
		const text = strip(state.footer.render(200).join("\n"));
		if (identity.startsWith("/repo/linked")) assert.ok(text.includes("main  worktree linked") && text.includes("dir src"));
		else assert.ok(text.includes("one  worktree main"));
	});
	const calls = h.calls.length;
	const reads = h.reads.length;
	for (let i = 0; i < 20; i++) state.footer.render(100);
	check("renders do not launch subprocesses or read files", () => { assert.equal(h.calls.length, calls); assert.equal(h.reads.length, reads); });
	await h.fire("session_shutdown", state);
}

{
	const h = harness(code);
	h.identity = "";
	const state = h.context("tui", true, "/tmp/plain-folder");
	state.branchLabel = "";
	await h.fire("session_start", state);
	check("non-Git directories keep cwd and session identity", () => {
		const text = strip(state.footer.render(120).join("\n"));
		assert.ok(text.includes("plain-folder") && text.includes(state.ctx.sessionManager.getSessionId()));
		assert.ok(!text.includes("worktree") && !text.includes("branch"));
	});
	await h.fire("session_shutdown", state);
}

{
	const h = harness(code);
	const state = h.context();
	await h.fire("session_start", state);
	await h.toggle(state);
	await h.command("session-ref", state);
	check("session-ref works with footer disabled and copies context only", () => {
		assert.equal(h.copies.length, 1);
		const text = h.copies[0];
		for (const s of [state.ctx.sessionManager.getSessionId(), 'Session file: "/sessions/test.jsonl"', 'Working directory: "/repo/one"', "Do not resume", "snapshot", "Current branch leaf: active-leaf", "untrusted context"]) assert.ok(text.includes(s), s);
		assert.ok(!text.includes("pi --resume") && !text.includes("pi --session"));
		assert.ok(state.notices.at(-1)?.includes("copied"));
	});
	state.ctx.sessionManager.getLeafId = () => "older-selected-leaf";
	state.ctx.sessionManager.getSessionFile = () => '/custom sessions/session "quoted".jsonl';
	await h.command("session-ref", state);
	check("session-ref pins the selected branch and exact custom session path", () => {
		assert.ok(h.copies[1].includes("Current branch leaf: older-selected-leaf"));
		assert.ok(h.copies[1].includes(`Session file: ${JSON.stringify(state.ctx.sessionManager.getSessionFile())}`));
	});
	const copyCount = h.copies.length;
	h.saved = false;
	await h.command("session-ref", state);
	check("session-ref rejects transcript not yet saved", () => {
		assert.equal(h.copies.length, copyCount);
		assert.ok(state.notices.at(-1)?.includes("No saved transcript"));
	});
	state.ctx.sessionManager.getSessionFile = () => undefined;
	await h.command("session-ref", state);
	check("session-ref rejects ephemeral sessions", () => assert.equal(h.copies.length, copyCount));
	state.ctx.sessionManager.getSessionFile = () => "/sessions/test.jsonl";
	h.saved = true;
	h.copyError = true;
	await h.command("session-ref", state);
	check("clipboard errors report failure without changing footer resources", () => {
		assert.equal(h.copies.length, copyCount);
		assert.ok(state.notices.at(-1)?.includes("Could not copy"));
		assert.equal(h.timers.size, 0);
	});
	await h.fire("session_shutdown", state);
}

{
	const h = harness(code);
	h.hold = true;
	const state = h.context();
	await h.fire("session_start", state);
	await h.advance(2000);
	check("checkout lookup timeout uses the same bounded subprocess slot", () => {
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[0].timeout, 2000);
		assert.equal(h.maxRunning, 1);
	});
	h.calls[1].complete();
	await flush();
	check("failed identity lookup leaves cwd and UUID usable", () => {
		const text = strip(state.footer.render(120).join("\n"));
		assert.ok(text.includes("one") && text.includes(state.ctx.sessionManager.getSessionId()));
	});
	await h.advance(2000);
	check("identity lookup is not repeated on each poll", () => {
		assert.equal(h.calls.filter(c => c.args[0] === "rev-parse").length, 1);
	});
	await h.fire("session_shutdown", state);
	await h.advance(4000);
}

{
	const h = harness(code);
	const state = h.context();
	state.ctx.sessionManager.getSessionName = () => "";
	state.statuses.clear();
	h.output = "";
	await h.fire("session_start", state);
	check("empty checkout right group leaves identity unpadded", () => {
		const rows = state.footer.render(160).map(strip);
		assert.ok(rows[0].startsWith("one  worktree main  branch main"));
		assert.equal(rows[0], rows[0].trimEnd());
		assert.ok(visibleWidth(rows[0]) < 160);
	});
	check("UUID-only narrow row has no padding or optional traffic", () => {
		const last = strip(state.footer.render(44).at(-1));
		assert.equal(last, `session ${state.ctx.sessionManager.getSessionId()}`);
	});
	await h.fire("before_agent_start", state);
	await h.advance(9000);
	const before = strip(state.footer.render(100)[0]);
	await h.advance(1000);
	const after = strip(state.footer.render(100)[0]);
	check("timer width changes move only the start of the right group", () => {
		assert.ok(before.endsWith("working 9s") && after.endsWith("working 10s"));
		assert.equal(visibleWidth(before), 100);
		assert.equal(visibleWidth(after), 100);
		assert.ok(before.startsWith("one  worktree main") && after.startsWith("one  worktree main"));
	});
	await h.fire("agent_settled", state);
	check("settled checkout returns to an unpadded left group", () => {
		const row = strip(state.footer.render(100)[0]);
		assert.ok(!row.includes("working"));
		assert.equal(row, row.trimEnd());
	});
	await h.fire("session_shutdown", state);
}

{
	const h = harness(code);
	const state = h.context();
	await h.fire("session_start", state);
	await h.fire("before_agent_start", state);
	check("all widths stay bounded with crowded colored and Unicode groups", () => {
		for (const size of [1, 5, 20]) {
			state.ctx.model = { id: "model", name: "模型 🚀 ".repeat(size), provider: "company-model-router-".repeat(size) };
			state.ctx.sessionManager.getSessionName = () => "session-title-".repeat(size);
			state.branchLabel = "branch-".repeat(size);
			state.statuses.set("meter", `\x1b[31m${"status-".repeat(size)}\x1b[0m`);
			for (let width = 0; width <= 220; width++) {
				const rows = state.footer.render(width);
				assert.equal(rows.length, width < 80 ? 4 : 3);
				assert.ok(rows.every((row: string) => visibleWidth(row) <= width), `size ${size}, width ${width}`);
				if (width >= 36) assert.ok(strip(rows.at(-1)).includes(state.ctx.sessionManager.getSessionId()));
				if (width >= 36) assert.ok(strip(rows[0]).endsWith("working 0s"));
			}
		}
	});
	await h.fire("session_shutdown", state);
}

console.log(`ALL PASS (${checks} checks)`);
