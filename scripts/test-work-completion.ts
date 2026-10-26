#!/usr/bin/env bun
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension, { parseRepoStatus, scanRepoStatus, type RepoStatus } from "../pi/.pi/agent/extensions/work-completion.ts";

let checks = 0;
function check(name: string, test: () => void) { test(); checks++; console.log(`PASS ${name}`); }
const base = (patch: Partial<RepoStatus> = {}): RepoStatus => ({ root: "/repo", commonDir: "/repo/.git", branch: "task", head: "a",
	dirty: [], upstream: "origin/task", ahead: 0, behind: 0, defaultBranch: "main", isHelloFresh: false,
	publication: "cached", operation: false, ...patch });
const dirt = (path = "old.txt", status = " M") => ({ path, status });
class Harness {
	handlers = new Map<string, Function>();
	commands = new Map<string, Function>();
	entries: any[] = [];
	notices: { text: string; level: string }[] = [];
	widgets: any[] = [];
	statuses: (string | undefined)[] = [];
	calls = 0;
	session = "session-1";
	mode = "tui";
	hasUI = true;
	cwd = "/repo";
	now = base();
	scanner: (cwd: string, signal: AbortSignal) => Promise<RepoStatus>;
	constructor(scanner?: (cwd: string, signal: AbortSignal) => Promise<RepoStatus>) {
		this.scanner = scanner ?? (async () => structuredClone(this.now));
		this.load();
	}
	load() {
		this.handlers.clear(); this.commands.clear();
		extension({ on: (name: string, fn: Function) => this.handlers.set(name, fn),
			registerCommand: (name: string, def: any) => this.commands.set(name, def.handler),
			appendEntry: (customType: string, data: any) => this.entries.push({ type: "custom", customType, data }),
			sendMessage: () => assert.fail("model message"), sendUserMessage: () => assert.fail("submit"),
			registerTool: () => assert.fail("model tool"),
		} as any, async (cwd, signal) => { this.calls++; return this.scanner(cwd, signal); });
	}
	ctx() { // Every event gets a fresh context, like the real host.
		return { mode: this.mode, hasUI: this.hasUI, cwd: this.cwd,
			sessionManager: { getSessionId: () => this.session, getBranch: () => this.entries },
			ui: { setWidget: (_id: string, f: any) => this.widgets.push(f?.({}, { fg: (_c: string, t: string) => t })),
				setStatus: (_id: string, t: string | undefined) => this.statuses.push(t),
				notify: (text: string, level: string) => this.notices.push({ text, level }),
				confirm: () => assert.fail("dialog"), setEditorText: () => assert.fail("editor change") },
		} as any;
	}
	fire(name: string, event: any = {}) { return this.handlers.get(name)!(event, this.ctx()); }
	command() { return this.commands.get("work-status")!("", this.ctx()); }
	last() { return this.entries.at(-1)?.data; }
	line(width = 120) { return this.widgets.at(-1)?.render(width)[0] ?? ""; }
}
const h = new Harness();
h.now = base({ dirty: [dirt()] });
await h.fire("session_start");
check("startup scans once, persists baseline, shows preexisting pending work without notice", () => {
	assert.equal(h.calls, 1); assert.equal(h.entries.length, 1); assert.equal(h.notices.length, 0);
	assert.equal(h.last().changedObserved, false); assert.match(h.line(), /1 changed \(1 present at start\)/);
});
await h.fire("agent_settled"); await h.fire("agent_settled", { aborted: true });
check("repeated unchanged settlement is advisory and deduplicated", () => {
	assert.equal(h.entries.length, 1); assert.equal(h.notices.length, 0);
	assert(!h.handlers.has("agent_end") && !h.handlers.has("agent_before_settle"));
});
h.now = base({ dirty: [dirt(), dirt("new.txt", "??")] });
await h.fire("agent_settled");
check("same HEAD with new dirty path persists change observation and warns once", () => {
	assert.equal(h.last().baseline.head, "a"); assert.equal(h.last().baseline.dirty.length, 1);
	assert.equal(h.last().changedObserved, true); assert.equal(h.notices.length, 1);
	assert.match(h.line(), /2 changed \(1 present at start\)/);
});
await h.fire("agent_settled");
check("same pending state does not repeat entries or warnings", () => { assert.equal(h.entries.length, 2); assert.equal(h.notices.length, 1); });
await h.command();
check("explicit command reports metadata without submission or dialog", () => {
	assert.match(h.notices.at(-1)!.text, /\/repo \(task\)/);
	assert.match(h.notices.at(-1)!.text, /Dirty: 1 at start, 2 now/);
	assert.match(h.notices.at(-1)!.text, /Publication: cached/);
	assert.match(h.notices.at(-1)!.text, /Deployment not checked/);
	assert.equal(h.entries.length, 2);
});
check("widget is exactly one width-safe line, including very narrow widths", () => {
	for (const width of [1, 8, 20, 40, 80]) {
		const lines = h.widgets.at(-1).render(width);
		assert.equal(lines.length, 1); assert(visibleWidth(lines[0]) <= width);
	}
	assert.match(h.statuses.at(-1)!, /2 changed/);
});
await h.fire("session_shutdown"); h.load(); await h.fire("session_start");
check("reload restores original baseline and changedObserved, with no duplicate entry", () => {
	assert.equal(h.last().baseline.dirty.length, 1); assert.equal(h.last().changedObserved, true);
	assert.equal(h.entries.length, 2); assert.equal(h.notices.length, 2);
});
h.now = base({ head: "b", dirty: [] }); await h.fire("agent_settled", { aborted: true });
check("aborted run with changed HEAD remains advisory and never claims fresh publication", () => {
	assert.equal(h.last().baseline.head, "a"); assert.equal(h.last().lastStatus.head, "b");
	assert.match(h.line(), /Publication unchecked/); assert(!/pushed|deployed|published/.test(h.line()));
});
h.now = base({ head: "b", upstream: null, ahead: null, behind: null, publication: "unknown" });
await h.fire("agent_settled"); await h.command();
check("unknown upstream stays unknown instead of asserting publication", () => {
	assert.match(h.notices.at(-1)!.text, /Publication: unknown. Ahead: unknown, behind: unknown/);
	assert.match(h.line(), /check-remove before removal/);
});
h.now = base({ head: "b", ahead: 3 }); await h.fire("agent_settled");
check("clean ahead branch still requires a removal publication check", () => assert.match(h.line(), /Publication unchecked/));
h.now = base({ operation: true }); await h.fire("agent_settled");
check("Git operation is visible but not blocked", () => assert.match(h.line(), /operation in progress/));
await h.fire("session_tree");
check("session tree restores branch entries without resetting baseline", () => assert.equal(h.last().baseline.dirty.length, 1));
h.session = "session-2"; await h.fire("session_start");
check("different session does not borrow prior baseline", () => { assert.equal(h.last().sessionId, "session-2"); assert.equal(h.last().baseline.dirty.length, 0); assert.equal(h.last().changedObserved, false); });
h.now = base({ root: "/other", commonDir: "/other/.git", dirty: [dirt("foreign")] }); await h.command();
check("different repo root captures its own baseline", () => { assert.equal(h.last().root, "/other"); assert.equal(h.last().baseline.dirty[0].path, "foreign"); });
const reordered = new Harness(); reordered.now = base({ dirty: [dirt("z"), dirt("a")] }); await reordered.fire("session_start");
const orderEntries = reordered.entries.length;
reordered.now.dirty.reverse(); await reordered.fire("agent_settled");
check("dirty ordering alone is not a meaningful warning or durable write", () => {
	assert.equal(reordered.notices.length, 0); assert.equal(reordered.last().changedObserved, false); assert.equal(reordered.entries.length, orderEntries);
});
reordered.now.dirty[0].status = "M "; await reordered.fire("agent_settled");
check("dirty status changes with unchanged head are observed without attribution", () => { assert.equal(reordered.last().changedObserved, true); assert.match(reordered.line(), /2 present at start/); });
for (const [mode, hasUI] of [["rpc", true], ["print", false], ["json", false], ["tui", false]] as const) {
	const child = new Harness(); child.mode = mode; child.hasUI = hasUI;
	await child.fire("session_start"); await child.fire("agent_settled"); await child.fire("session_tree"); await child.command(); await child.fire("session_shutdown");
	check(`${mode}/${hasUI} child performs no scans, writes or UI`, () => {
		assert.equal(child.calls, 0); assert.equal(child.entries.length, 0); assert.equal(child.widgets.length, 0); assert.equal(child.notices.length, 0);
	});
}
const cleanup = new Harness(); await cleanup.fire("session_start");
const ownedWidgets = cleanup.widgets.length, ownedStatuses = cleanup.statuses.length;
for (const [mode, hasUI] of [["rpc", true], ["print", false], ["tui", false]] as const) {
	cleanup.mode = mode; cleanup.hasUI = hasUI; await cleanup.fire("session_shutdown");
}
cleanup.mode = "tui"; cleanup.hasUI = true;
const foreign = cleanup.ctx(); foreign.sessionManager = { ...foreign.sessionManager, getSessionId: () => "SDK-child" };
await cleanup.handlers.get("session_shutdown")!({}, foreign);
check("headless and SDK child shutdown cannot clear parent widget or footer", () => {
	assert.equal(cleanup.widgets.length, ownedWidgets); assert.equal(cleanup.statuses.length, ownedStatuses);
	assert.match(cleanup.line(), /Publication unchecked/);
});
await cleanup.fire("session_shutdown");
check("owned shutdown clears widget and footer with fresh context, without scan or dialog", () => {
	assert.equal(cleanup.widgets.at(-1), undefined); assert.equal(cleanup.statuses.at(-1), undefined);
	assert.equal(cleanup.calls, 1); assert.equal(cleanup.notices.length, 0); assert.equal(cleanup.entries.length, 1);
});
const clearedWidgets = cleanup.widgets.length, clearedStatuses = cleanup.statuses.length;
await cleanup.fire("session_shutdown"); await cleanup.command(); await cleanup.fire("agent_settled");
check("repeated shutdown and later events cannot clear or refresh relinquished ownership", () => {
	assert.equal(cleanup.widgets.length, clearedWidgets); assert.equal(cleanup.statuses.length, clearedStatuses);
	assert.equal(cleanup.calls, 1); assert.equal(cleanup.notices.length, 0);
});
const missing = new Harness(async () => { throw new Error("secret stderr must not surface"); });
await missing.fire("session_start"); await missing.fire("agent_settled"); await missing.command();
check("missing CLI fails visibly with one warning only and no persisted claims", () => {
	assert.equal(missing.notices.length, 1); assert.equal(missing.entries.length, 0);
	assert.match(missing.line(), /unavailable/); assert(!missing.notices[0].text.includes("secret"));
});
const failingAfterSuccess = new Harness(); await failingAfterSuccess.fire("session_start");
failingAfterSuccess.scanner = async () => { throw new Error("failed"); };
await failingAfterSuccess.fire("agent_settled"); await failingAfterSuccess.command();
check("failed refresh makes both widget and footer unavailable without rewriting known state", () => {
	assert.match(failingAfterSuccess.line(), /unavailable/); assert.match(failingAfterSuccess.statuses.at(-1)!, /unavailable/);
	assert.equal(failingAfterSuccess.entries.length, 1); assert.equal(failingAfterSuccess.notices.length, 1);
});
let release!: (s: RepoStatus) => void;
let capturedSignal!: AbortSignal;
const slow = new Harness(async (_cwd, signal) => { capturedSignal = signal; return new Promise((r) => release = r); });
const late = slow.fire("session_start"); await Promise.resolve(); await Promise.resolve();
await slow.fire("session_shutdown"); release(base()); await late;
check("shutdown aborts scan and late resolution cannot update state or repaint UI", () => {
	assert(capturedSignal.aborted); assert.equal(slow.entries.length, 0); assert.deepEqual(slow.widgets, [undefined]);
	assert.deepEqual(slow.statuses, [undefined]); assert.equal(slow.calls, 1); assert.equal(slow.notices.length, 0);
});
let active = 0, peak = 0;
const serialized = new Harness(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return base(); });
await serialized.fire("session_start");
await Promise.all([serialized.fire("agent_settled"), serialized.command(), serialized.command()]);
check("overlapping refreshes serialize child processes", () => { assert.equal(peak, 1); assert.equal(serialized.entries.length, 1); });
let resolveOld!: (s: RepoStatus) => void;
const switched = new Harness(async () => switched.calls === 1 ? new Promise((r) => resolveOld = r) : base({ head: "new" }));
const first = switched.fire("session_start"); await Promise.resolve(); await Promise.resolve();
switched.session = "next"; const second = switched.fire("session_start"); resolveOld(base({ head: "old" })); await Promise.all([first, second]);
check("local generation rejects prior session results with fresh event contexts", () => { assert.equal(switched.entries.length, 1); assert.equal(switched.last().sessionId, "next"); assert.equal(switched.last().baseline.head, "new"); });
const modeChange = new Harness(async () => new Promise((r) => release = r));
const waiting = modeChange.fire("session_start"); await Promise.resolve(); await Promise.resolve();
// The captured event context itself can lose UI permission before an await returns.
// Also test a mismatched event cannot take ownership from the TUI runtime.
modeChange.mode = "rpc"; await modeChange.fire("session_shutdown"); release(base()); await waiting;
check("RPC shutdown cannot take ownership of a TUI runtime", () => assert.equal(modeChange.entries.length, 1));
const mutable = new Harness(async () => new Promise((r) => release = r));
const ctx = mutable.ctx(); const pending = mutable.handlers.get("session_start")!({}, ctx);
await Promise.resolve(); await Promise.resolve(); ctx.hasUI = false; release(base()); await pending;
check("UI guard is checked again after scan before every write", () => { assert.equal(mutable.entries.length, 0); assert.equal(mutable.widgets.length, 0); });
const malformed = new Harness(); malformed.entries.push({ type: "custom", customType: "work-completion:state", data: { version: 1, root: "/repo", sessionId: "session-1", baseline: { head: "x", dirty: "bad" } } }); await malformed.fire("session_start");
check("malformed persisted entry cannot supply a baseline", () => assert.equal(malformed.last().baseline.head, "a"));
check("contract validation rejects malformed CLI data and copies metadata only", () => {
	for (const patch of [{ ahead: -1 }, { dirty: [{}] }, { publication: "fresh" }, { root: "relative" }, { branch: 42 }]) assert.throws(() => parseRepoStatus({ ...base(), ...patch }));
	assert(!("content" in parseRepoStatus({ ...base(), content: "secret" })));
});

const area = mkdtempSync(join(tmpdir(), "work-completion-unit-"));
const oldBin = process.env.PI_REPO_GUARD_BIN;
try {
	const script = join(area, "guard.mjs"), argsFile = join(area, "args.json");
	writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(base()))});`);
	process.env.PI_REPO_GUARD_BIN = script;
	const scanned = await scanRepoStatus("/repo with spaces", new AbortController().signal);
	check("real execFile uses Node, absolute fixture and status-only argv", () => {
		assert.equal(scanned.head, "a"); assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), ["status", "--json", "--cwd", "/repo with spaces"]);
	});
	process.env.PI_REPO_GUARD_BIN = "relative";
	await assert.rejects(scanRepoStatus("/repo", new AbortController().signal));
	check("relative CLI override is rejected", () => {});
	process.env.PI_REPO_GUARD_BIN = script;
	writeFileSync(script, "setTimeout(()=>{},30000);");
	const controller = new AbortController(); const before = Date.now();
	const cancel = scanRepoStatus(area, controller.signal); controller.abort(); await assert.rejects(cancel);
	check("real child abort completes promptly", () => assert(Date.now() - before < 2000));
	const timeoutStart = Date.now(); await assert.rejects(scanRepoStatus(area, new AbortController().signal));
	check("scan timeout kills hung child within the 5-second budget", () => assert(Date.now() - timeoutStart < 6500));
	const real = resolve(import.meta.dir, "../git/.local/bin/repo-guard");
	if (existsSync(real)) {
		process.env.PI_REPO_GUARD_BIN = real;
		const status = await scanRepoStatus(resolve(import.meta.dir, ".."), new AbortController().signal);
		check("actual candidate CLI contract works through production scanner", () => { assert.equal(status.root, resolve(import.meta.dir, "..")); assert.equal(status.publication, "cached"); });
		const noRemote = mkdtempSync(join(area, "no-remote-"));
		execFileSync("git", ["init", "-b", "main", noRemote], { stdio: "ignore" });
		execFileSync("git", ["-C", noRemote, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture baseline"], { stdio: "ignore" });
		const unknown = await scanRepoStatus(noRemote, new AbortController().signal);
		check("real repo without any remote reports unknown publication through production scanner", () => {
			assert.equal(unknown.root, realpathSync(noRemote)); assert.equal(unknown.publication, "unknown");
			assert.equal(unknown.upstream, null); assert.equal(unknown.ahead, null); assert.equal(unknown.behind, null);
			assert.equal(unknown.defaultBranch, null);
		});
		const outside = new Harness((cwd, signal) => scanRepoStatus(cwd, signal)); outside.cwd = area;
		await outside.fire("session_start"); await outside.command(); await outside.command();
		check("real non-Git cwd remains visibly unavailable with one warning and no durable state", () => {
			assert.match(outside.line(), /unavailable/); assert.equal(outside.notices.length, 1); assert.equal(outside.entries.length, 0);
		});
	} else console.log("SKIP actual candidate CLI not yet available");
	const src = readFileSync(resolve(import.meta.dir, "../pi/.pi/agent/extensions/work-completion.ts"), "utf8");
	check("source has no timers, Git renderer, model submission or commit operations", () => {
		assert(!/setTimeout|setInterval|sendUserMessage|sendMessage|execSync|fetch\(/.test(src));
		assert.equal((src.match(/execFile\(/g) ?? []).length, 1);
	});
} finally {
	if (oldBin === undefined) delete process.env.PI_REPO_GUARD_BIN; else process.env.PI_REPO_GUARD_BIN = oldBin;
	rmSync(area, { recursive: true, force: true });
}
console.log(`Checks: ${checks} passed`);
