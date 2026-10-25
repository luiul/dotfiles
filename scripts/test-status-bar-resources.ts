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
	let holdGit = false;
	let running = 0;
	let maxRunning = 0;
	let gitOutput = "# branch.ab +2 -3\n1 .M file\n? new\n";
	const execFile = (command: string, args: string[], options: any, callback: Function) => {
		assert.equal(command, "git");
		assert.equal(options.killSignal, "SIGKILL", "git timeout must reclaim a stubborn child");
		running++;
		maxRunning = Math.max(maxRunning, running);
		let timeout: any;
		const call = {
			cwd: options.cwd, timeout: options.timeout, args, done: false,
			complete: (stdout = gitOutput, error?: Error) => {
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
			if (name === "node:fs") return { readFileSync: (path: string) => {
				reads.push(path);
				return JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384 } });
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
			fg: (color: string, text: string) => `\x1b[38;5;${color.length + 230}m${text}\x1b[0m`,
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
							getGitBranch: () => "main",
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
					getSessionName: () => "test session",
					getBranch: () => [{ type: "message", message: {
						role: "assistant", stopReason: "stop",
						usage: { input: 1000, output: 2000, cacheRead: 4000, cacheWrite: 100, cost: { total: 0.123 } },
					} }],
				},
				model: { id: "model-id", name: "Model Name", provider: "router" },
				getContextUsage: () => ({ tokens: 30000, contextWindow: 128000, percent: 23.4375 }),
			},
			subscribers, history, notices,
			get footer() { return footer; },
			get renders() { return renders; },
			get footerSets() { return footerSets; },
			branch: () => { for (const fn of subscribers) fn(); },
		};
		return state;
	};
	return {
		calls, reads, context, timers,
		set hold(value: boolean) { holdGit = value; },
		set output(value: string) { gitOutput = value; },
		get maxRunning() { return maxRunning; },
		intervals: () => [...timers.values()].filter(t => t.interval !== undefined).map(t => t.interval).sort(),
		fire: async (name: string, state: ReturnType<typeof context>) => { await handlers.get(name)?.({}, state.ctx); await flush(); },
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
	check(`${mode} hasUI=${hasUI} has no footer resources or settings reads`, () => {
		assert.equal(h.calls.length, 0);
		assert.equal(h.reads.length, 0);
		assert.equal(h.timers.size, 0);
		assert.equal(state.footerSets, 0);
		assert.equal(state.renders, 0);
		assert.equal(state.notices.length, 0);
	});
	if (mode === "sdk" || mode === "rpc") {
		const after = await measure(code, mode, hasUI);
		const before = baselineCode ? await measure(baselineCode, mode, hasUI) : undefined;
		console.log(`12s mock ${mode}: baseline=${before ? JSON.stringify(before) : "not supplied"} after=${JSON.stringify(after)}`);
		if (before) check(`${mode} measurement pins four baseline git calls and zero after`, () => {
			assert.equal(before.git, 4);
			assert.equal(after.git, 0);
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
	});
	await h.advance(12000);
	check("TUI retains startup plus three polls over 12s, rendering once per refresh", () => {
		assert.equal(h.calls.length, 4);
		assert.equal(state.renders, 4);
		assert.ok(h.calls.every(c => c.timeout === 2000 && c.args.join(" ") === "status --porcelain=2 --branch"));
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
	check("branch refreshes coalesce while one git subprocess runs", () => assert.equal(h.calls.length, 2));
	h.calls[1].complete("# branch.ab +5 -6\n? only\n");
	await flush();
	check("one queued refresh runs after completion without overlap", () => { assert.equal(h.calls.length, 3); assert.equal(h.maxRunning, 1); });
	h.calls[2].complete("# branch.ab +5 -6\n? only\n");
	await flush();
	check("parsed git state still renders changed, ahead and behind", () => {
		const text = state.footer.render(160).join("\n");
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
		h.calls[1].complete("# branch.ab +1 -0\n? fresh\n");
		await flush();
		check(`${transition} renders only the fresh generation`, () => {
			assert.equal(next.renders, nextRenders + 1);
			assert.ok(next.footer.render(160).join("\n").includes("changed 1"));
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
	for (const width of [45, 79, 80, 120, 200]) {
		check(`footer rendering matches baseline at width ${width}`, () => assert.equal(JSON.stringify(c.footer.render(width)), JSON.stringify(b.footer.render(width))));
	}
	await baseline.fire("before_agent_start", b);
	await current.fire("before_agent_start", c);
	await baseline.advance(12000);
	await current.advance(12000);
	check("active wide and narrow footer rendering matches baseline", () => {
		for (const width of [60, 160]) assert.equal(JSON.stringify(c.footer.render(width)), JSON.stringify(b.footer.render(width)));
	});
	check("TUI polling cadence matches baseline with one fewer idle render timer", () => {
		assert.equal(current.calls.length, baseline.calls.length);
		assert.equal(current.calls.length, 4);
		assert.equal(current.intervals().length, baseline.intervals().length - 1);
	});
	await baseline.fire("session_shutdown", b);
	await current.fire("session_shutdown", c);
	b.footer.dispose();
}
console.log(`ALL PASS (${checks} checks)`);
