// Tracker-only checks. Real files and Git, with measured subprocess counts.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as fsPromises from "node:fs/promises";
import { spyOn } from "bun:test";

// Simulate a registry left behind by the baseline module before importing the new tracker.
const registryKey = Symbol.for("pi.filechanges.tracker");
(globalThis as any)[registryKey] = { bySession: new Map([["legacy", {}]]), pending: {} };
const { __setTmpRootsForTest, getSharedFileChangesTracker } = await import("../pi/.pi/agent/extensions/filechanges-tracker.ts");
// Resolve the actual host's sibling dependencies, not a separate agent-core installation.
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { runToolCall } = await import(import.meta.resolve("@earendil-works/pi-agent-core", hostEntry));
const { Type } = await import(import.meta.resolve("typebox", hostEntry));

class MockPi {
	handlers = new Map<string, Function[]>();
	entries: any[] = [];
	on(name: string, fn: Function) { const handlers = this.handlers.get(name) ?? []; handlers.push(fn); this.handlers.set(name, handlers); }
	appendEntry(customType: string, data: any) { this.entries.push({ type: "custom", customType, data }); }
	async fire(name: string, ctx: any, event: any = {}) { for (const fn of this.handlers.get(name) ?? []) await fn(event, ctx); }
}
let nextId = 0;
function context(cwd: string, entries: any[] = []) {
	const id = String(++nextId);
	return { cwd, mode: "print", sessionManager: { getSessionId: () => id, getBranch: () => entries } };
}
function harness(cwd: string, entries: any[] = []) {
	const pi = new MockPi();
	const ctx = context(cwd, entries);
	const tracker = getSharedFileChangesTracker(pi as any);
	return { pi, ctx, tracker };
}
async function mutate(h: ReturnType<typeof harness>, path: string, content: string | Buffer | null, error = false) {
	const toolCallId = String(++nextId);
	await h.pi.fire("tool_call", h.ctx, { toolName: "write", input: { path }, toolCallId });
	if (content === null) await unlink(resolve(h.ctx.cwd, path));
	else await writeFile(resolve(h.ctx.cwd, path), content);
	await h.pi.fire("tool_result", h.ctx, { toolName: "write", toolCallId, isError: error });
	await h.pi.fire("tool_execution_end", h.ctx, { toolName: "write", toolCallId, isError: error, durationMs: 0 });
}
async function bash(h: ReturnType<typeof harness>, command: string, action: () => Promise<void>, error = false) {
	const toolCallId = String(++nextId);
	await h.pi.fire("tool_call", h.ctx, { toolName: "bash", input: { command }, toolCallId });
	await action();
	await h.pi.fire("tool_result", h.ctx, { toolName: "bash", toolCallId, isError: error });
	await h.pi.fire("tool_execution_end", h.ctx, { toolName: "bash", toolCallId, isError: error, durationMs: 0 });
}
const dir = await mkdtemp(join(tmpdir(), "fc-tracker-"));
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const oldPath = process.env.PATH;
const log = join(dir, "git-operations.log");
const fakeBin = join(dir, "bin");
const h = harness(join(dir, "repo"));
const all = [h];
let assertions = 0;
function check(name: string, action: () => void) { action(); assertions++; console.log(`ok ${name}`); }
async function operations() { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean); }
try {
	check("registry migration drops legacy session and pending references", () => {
		const registry = (globalThis as any)[registryKey];
		assert.equal(registry.bySession.size, 0); assert(!("pending" in registry));
	});
	await mkdir(h.ctx.cwd);
	await mkdir(fakeBin);
	await writeFile(join(fakeBin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ -n "$FC_FAIL_STATUS" ] && [ "$1" = status ]; then exit 2; fi\nif [ -n "$FC_SLOW_STATUS" ] && [ "$1" = status ]; then exec sleep 3; fi\nexec '${realGit}' "$@"\n`);
	await chmod(join(fakeBin, "git"), 0o755);
	await writeFile(log, "");
	process.env.PATH = `${fakeBin}:${oldPath}`;
	__setTmpRootsForTest([join(dir, "excluded")]);
	const git = (...args: string[]) => execFileSync(realGit, args, { cwd: h.ctx.cwd, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(h.ctx.cwd, "base.txt"), "base\n");
	git("add", "base.txt");
	git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "base");
	await h.pi.fire("session_start", h.ctx);
	check("factory and empty startup have no Git operations", () => assert.equal(require("node:fs").readFileSync(log, "utf8"), ""));
	await mutate(h, "base.txt", "base\nmore\n");
	check("counts use captured original", () => assert.equal(h.tracker.getChanges()[0].added, 1));
	const rows = h.tracker.getChanges();
	const operationsBeforeRead = (await operations()).length;
	const start = performance.now();
	for (let i = 0; i < 10000; i++) assert.strictEqual(h.tracker.getChanges(), rows);
	console.log(`measurement: 10000 cached reads ${(performance.now() - start).toFixed(2)}ms, ${(await operations()).length - operationsBeforeRead} Git calls`);
	check("array and projections frozen", () => { assert(Object.isFrozen(rows)); assert(Object.isFrozen(rows[0])); });
	const rowBeforeNoop = rows[0];
	const diffsBefore = (await operations()).filter((line) => line.startsWith("diff ")).length;
	await mutate(h, "base.txt", "base\nmore\n");
	check("no-op preserves row cache and timestamp", () => { assert.strictEqual(h.tracker.getChanges(), rows); assert.equal(h.tracker.getChanges()[0].updatedAt, rowBeforeNoop.updatedAt); });
	await h.pi.fire("agent_settled", h.ctx);
	const settledRows = h.tracker.getChanges();
	check("settle retains markers without another diff", () => { assert(settledRows[0].touchedThisPrompt); });
	console.log(`measurement: no-op plus settle additional diffs ${(await operations()).filter((line) => line.startsWith("diff ")).length - diffsBefore}`);
	check("no-op and settle use zero extra diffs", () => assert.equal((require("node:fs").readFileSync(log, "utf8") as string).split("\n").filter((line) => line.startsWith("diff ")).length, diffsBefore));
	const beforeBoundary = (await operations()).length;
	await h.pi.fire("before_agent_start", h.ctx, { messageType: "custom" });
	await h.pi.fire("agent_start", h.ctx);
	check("custom start and retry preserve cached marker", () => assert.strictEqual(h.tracker.getChanges(), settledRows));
	await h.pi.fire("before_agent_start", h.ctx, { messageType: "user" });
	check("user boundary keeps cumulative rows, clears marker, persists reset", () => {
		assert.equal(h.tracker.getChanges().length, 1); assert.equal(h.tracker.getChanges()[0].touchedThisPrompt, false);
		assert.deepEqual(h.pi.entries.at(-1).data.promptPaths, []); assert(!("mode" in h.pi.entries.at(-1).data));
	});
	check("prompt boundary makes no Git calls", () => assert.equal((require("node:fs").readFileSync(log, "utf8") as string).trim().split("\n").length, beforeBoundary));
	const readSpy = spyOn(fsPromises, "readFile");
	const noEditRows = h.tracker.getChanges();
	await h.pi.fire("agent_start", h.ctx);
	await h.pi.fire("agent_settled", h.ctx);
	const noEditReads = readSpy.mock.calls.length;
	readSpy.mockRestore();
	check("no-edit prompt settle makes no content reads or Git calls", () => {
		assert.equal(noEditReads, 0); assert.strictEqual(h.tracker.getChanges(), noEditRows);
		assert.equal((require("node:fs").readFileSync(log, "utf8") as string).trim().split("\n").length, beforeBoundary);
	});
	console.log(`measurement: no-edit prompt and settle ${noEditReads} file reads, ${(await operations()).length - beforeBoundary} Git calls`);
	await mutate(h, "second.txt", "two\n");
	check("default always shows session set", () => assert.equal(h.tracker.getChanges().length, 2));
	await h.pi.fire("agent_start", h.ctx);
	await h.pi.fire("agent_settled", h.ctx);
	check("retry and settle retain current marker", () => assert(h.tracker.getChanges().find((row) => row.path === "second.txt")?.touchedThisPrompt));
	const beforeCoalesce = (await operations()).length;
	await Promise.all([h.tracker.refreshRepoStates(), h.tracker.refreshRepoStates(), h.tracker.refreshRepoStates()]);
	console.log(`measurement: three concurrent refreshes ${(await operations()).length - beforeCoalesce} Git calls`);
	check("concurrent refresh coalesces to status and ls-files", () => assert.equal((require("node:fs").readFileSync(log, "utf8") as string).trim().split("\n").length - beforeCoalesce, 2));
	await mutate(h, "content-dirty.txt", "before settle\n");
	await h.pi.fire("before_agent_start", h.ctx, { messageType: "user" });
	await writeFile(join(h.ctx.cwd, "content-dirty.txt"), "before settle\nmore\n");
	await h.pi.fire("agent_settled", h.ctx);
	check("marker-only persistence preserves prior unsettled content dirty", () => assert.equal(h.tracker.getChanges().find((row) => row.path === "content-dirty.txt")?.added, 2));
	await mutate(h, "content-dirty.txt", null);
	await mutate(h, "base.txt", "base\n");
	check("revert removes row and observed buffer", () => assert(!h.tracker.getChanges().some((row) => row.path === "base.txt")));
	await mutate(h, "base.txt", "fresh\n");
	check("post-revert touch captures fresh baseline", () => { const row = h.tracker.getChanges().find((item) => item.path === "base.txt")!; assert.equal(row.added, 1); assert.equal(row.removed, 1); });
	await mutate(h, "binary.dat", Buffer.from([0, 2, 3]));
	check("binary counts retained", () => { const row = h.tracker.getChanges().find((item) => item.path === "binary.dat")!; assert(row.binary); assert.equal(row.added, 0); });
	await h.pi.fire("agent_settled", h.ctx);
	const signatureH = harness(h.ctx.cwd); all.push(signatureH);
	await mutate(signatureH, "signature.txt", "aaaa\n");
	await mutate(signatureH, "deleted-signature.txt", "\n");
	signatureH.tracker.clear();
	await mutate(signatureH, "deleted-signature.txt", null);
	await mutate(signatureH, "signature.txt", "bbbb\n");
	await signatureH.pi.fire("agent_settled", signatureH.ctx);
	const unchangedRow = signatureH.tracker.getChanges().find((row) => row.path === "signature.txt")!;
	await writeFile(join(h.ctx.cwd, "signature.txt"), "cccc\n");
	await mutate(signatureH, "signature-trigger.txt", "trigger\n");
	await signatureH.pi.fire("agent_settled", signatureH.ctx);
	check("signatures detect same-length changed content", () => assert.notEqual(signatureH.tracker.getChanges().find((row) => row.path === "signature.txt")?.updatedAt, unchangedRow.updatedAt));
	const beforeSignatureDiffs = (await operations()).filter((line) => line.startsWith("diff ")).length;
	await mutate(signatureH, "signature-trigger.txt", "trigger\nagain\n");
	await signatureH.pi.fire("agent_settled", signatureH.ctx);
	check("unchanged text and null signatures skip repeated diffs", () => assert.equal((require("node:fs").readFileSync(log, "utf8") as string).split("\n").filter((line) => line.startsWith("diff ")).length - beforeSignatureDiffs, 1));
	await mutate(signatureH, "deleted-signature.txt", "");
	check("null signature differs from empty-file signature", () => assert.equal(signatureH.tracker.getChanges().find((row) => row.path === "deleted-signature.txt")?.kind, "modified"));
	await mutate(h, "package-lock.json", "ignored");
	await mkdir(join(dir, "excluded"));
	await mutate(h, join(dir, "excluded", "temp.txt"), "tmp");
	check("ignored and temp paths excluded", () => assert.equal(h.tracker.getChanges().length, 3));
	await mutate(h, "failed.txt", "partial\n", true);
	check("failed write actual mutations tracked", () => assert(h.tracker.getChanges().some((row) => row.path === "failed.txt")));
	await bash(h, "echo hi > failed-bash.txt", () => writeFile(join(h.ctx.cwd, "failed-bash.txt"), "partial bash\n"), true);
	check("failed bash actual mutations tracked", () => assert(h.tracker.getChanges().some((row) => row.path === "failed-bash.txt")));
	const lifecycle = harness(h.ctx.cwd); all.push(lifecycle);
	for (const [toolName, path, abort] of [["write", "blocked-lifecycle.txt", false], ["bash", "aborted-lifecycle.txt", true]] as const) {
		const absPath = join(h.ctx.cwd, path);
		await writeFile(absPath, "base\n");
		const toolCallId = `lifecycle-${toolName}`;
		const args = toolName === "write" ? { path, content: "should not run\n" } : { command: `echo session >> ${path}` };
		const controller = new AbortController();
		let executed = 0;
		let resultHooks = 0;
		const outcome = await runToolCall({ id: toolCallId, name: toolName, arguments: args }, {
			tools: [{ name: toolName, label: toolName, description: "Lifecycle reproduction", parameters: Type.Any(), execute: async () => { executed++; return { content: [], details: undefined }; } }],
			assistantMessage: { role: "assistant", content: [], timestamp: Date.now() },
			context: { messages: [], tools: [], systemPrompt: "" },
			signal: controller.signal,
			beforeToolCall: async () => {
				await lifecycle.pi.fire("tool_call", lifecycle.ctx, { toolName, toolCallId, input: args });
				if (abort) controller.abort();
				else return { block: true, reason: "Test blocks after capture" };
			},
			afterToolCall: async () => { resultHooks++; },
		});
		check(`real runToolCall ${toolName} skips execution and result hook`, () => { assert(outcome.isError); assert.equal(outcome.durationMs, undefined); assert.equal(executed, 0); assert.equal(resultHooks, 0); });
		const beforeEnd = (await operations()).length;
		const cleanupReadSpy = spyOn(fsPromises, "readFile");
		const end = { toolName, toolCallId, result: outcome.result, isError: true };
		await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, end);
		await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, end);
		const cleanupReads = cleanupReadSpy.mock.calls.length;
		cleanupReadSpy.mockRestore();
		check(`${toolName} preparation-end cleanup is idempotent and performs no reads or Git calls`, () => { assert.equal(cleanupReads, 0); assert.equal((require("node:fs").readFileSync(log, "utf8") as string).trim().split("\n").length, beforeEnd); assert.equal(lifecycle.tracker.getChanges().length, 0); });
		await writeFile(absPath, "base\nexternal\n");
		if (toolName === "write") await mutate(lifecycle, path, "base\nexternal\nsession\n");
		else await bash(lifecycle, `echo session >> ${path}`, () => writeFile(absPath, "base\nexternal\nsession\n"));
		check(`${toolName} stale captures released, later touch counts session append only`, () => assert.equal(lifecycle.tracker.getChanges().find((row) => row.path === path)?.added, 1));
		lifecycle.tracker.clear();
	}
	// Duration 0 is still a real execution. Reconcile partial writes if its result hook was missed.
	for (const toolName of ["write", "bash"] as const) {
		const path = `end-only-${toolName}.txt`;
		const toolCallId = `end-only-${toolName}`;
		await writeFile(join(h.ctx.cwd, path), "base\n");
		await lifecycle.pi.fire("tool_call", lifecycle.ctx, { toolName, toolCallId, input: toolName === "write" ? { path } : { command: `echo partial >> ${path}` } });
		await writeFile(join(h.ctx.cwd, path), "base\npartial\n");
		await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, { toolName, toolCallId, isError: true, durationMs: 0 });
		const completedRows = lifecycle.tracker.getChanges();
		await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, { toolName, toolCallId, isError: true, durationMs: 0 });
		await lifecycle.pi.fire("tool_result", lifecycle.ctx, { toolName, toolCallId, isError: true });
		check(`${toolName} executed error without result hook reconciles once`, () => { assert.equal(completedRows[0].added, 1); assert.strictEqual(lifecycle.tracker.getChanges(), completedRows); });
		lifecycle.tracker.clear();
	}
	// Releasing a blocked sibling must not drop the other in-flight user's first-touch bytes.
	await writeFile(join(h.ctx.cwd, "shared-end.txt"), "base\n");
	for (const toolCallId of ["blocked-sibling", "active-sibling"]) await lifecycle.pi.fire("tool_call", lifecycle.ctx, { toolName: "write", toolCallId, input: { path: "shared-end.txt" } });
	await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, { toolCallId: "blocked-sibling", toolName: "write", isError: true });
	await writeFile(join(h.ctx.cwd, "shared-end.txt"), "base\nsession\n");
	await lifecycle.pi.fire("tool_result", lifecycle.ctx, { toolCallId: "active-sibling", toolName: "write" });
	await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, { toolCallId: "active-sibling", toolName: "write", durationMs: 1 });
	check("blocked sibling releases only its shared capture reference", () => assert.equal(lifecycle.tracker.getChanges()[0].added, 1));
	lifecycle.tracker.clear();
	await writeFile(join(h.ctx.cwd, "shared-end.txt"), "base\nsession\nexternal\n");
	await mutate(lifecycle, "shared-end.txt", "base\nsession\nexternal\nnext session\n");
	check("normal result followed by end releases final shared reference", () => assert.equal(lifecycle.tracker.getChanges()[0].added, 1));
	await lifecycle.pi.fire("tool_call", lifecycle.ctx, { toolName: "bash", toolCallId: "end-after-shutdown", input: { command: "echo pending >> shared-end.txt" } });
	await lifecycle.pi.fire("session_shutdown", lifecycle.ctx);
	await lifecycle.pi.fire("tool_execution_end", lifecycle.ctx, { toolCallId: "end-after-shutdown", toolName: "bash", isError: true, durationMs: 0 });
	check("execution end after shutdown cannot revive state", () => { assert.equal(lifecycle.tracker.getChanges().length, 0); assert.equal(lifecycle.tracker.getContext(), null); });
	await writeFile(join(h.ctx.cwd, "concurrent.txt"), "initial\n");
	const call = (id: string) => h.pi.fire("tool_call", h.ctx, { toolName: "write", input: { path: "concurrent.txt" }, toolCallId: id });
	await Promise.all([call("parallel1"), call("parallel2")]);
	await writeFile(join(h.ctx.cwd, "concurrent.txt"), "initial\nfirst\nsecond\n");
	await Promise.all(["parallel2", "parallel1"].map((id) => h.pi.fire("tool_result", h.ctx, { toolName: "write", toolCallId: id })));
	check("concurrent same-file hooks preserve earliest Original", () => assert.equal(h.tracker.getChanges().find((row) => row.path === "concurrent.txt")?.added, 2));
	// One hook completes and mutates while the other capture is still awaiting Git.
	await writeFile(join(h.ctx.cwd, "mixed.txt"), "initial\n");
	const slowCapture = h.pi.fire("tool_call", h.ctx, { toolName: "bash", input: { command: "echo more >> mixed.txt" }, toolCallId: "mixed-bash" });
	await h.pi.fire("tool_call", h.ctx, { toolName: "write", input: { path: "mixed.txt" }, toolCallId: "mixed-write" });
	await writeFile(join(h.ctx.cwd, "mixed.txt"), "initial\nfirst\n");
	await h.pi.fire("tool_result", h.ctx, { toolName: "write", toolCallId: "mixed-write" });
	await slowCapture;
	await writeFile(join(h.ctx.cwd, "mixed.txt"), "initial\nfirst\nsecond\n");
	await h.pi.fire("tool_result", h.ctx, { toolName: "bash", toolCallId: "mixed-bash" });
	check("mixed parallel tool capture shares earliest bytes", () => assert.equal(h.tracker.getChanges().find((row) => row.path === "mixed.txt")?.added, 2));
	await mkdir(join(dir, "plain"));
	const outside = harness(join(dir, "plain")); all.push(outside);
	await mutate(outside, "same.txt", "outside\n");
	check("factory owners and sessions isolated", () => { assert.notStrictEqual(outside.tracker, h.tracker); assert.equal(outside.tracker.getChanges().length, 1); assert(!h.tracker.getChanges().some((row) => row.path === "same.txt")); });
	await bash(h, `echo next >> '${join(dir, "plain", "same.txt")}'`, () => writeFile(join(dir, "plain", "same.txt"), "outside\nnext\n"));
	check("bash tracks outside repo against before-content", () => assert.equal(h.tracker.getChanges().find((row) => row.absPath === join(realpathSync(join(dir, "plain")), "same.txt"))?.added, 1));
	const legacy = harness(h.ctx.cwd, [{ type: "custom", customType: "filechanges:session-set", data: {
		items: [
			{ path: "z.txt", absPath: join(h.ctx.cwd, "z.txt"), kind: "created", added: 1, updatedAt: 100 },
			{ path: "a.txt", absPath: join(h.ctx.cwd, "a.txt"), kind: "created", added: 1, updatedAt: 100 },
		], round: ["z.txt"], mode: "round",
	} }]); all.push(legacy);
	await legacy.pi.fire("session_start", legacy.ctx);
	check("legacy round is metadata, saved mode ignored, ties stable", () => { const rows = legacy.tracker.getChanges(); assert.deepEqual(rows.map((row) => row.path), ["a.txt", "z.txt"]); assert(!rows[0].touchedThisPrompt); assert(rows[1].touchedThisPrompt); });
	await legacy.pi.fire("before_agent_start", legacy.ctx);
	check("mock prompt boundary can omit messageType", () => assert(legacy.tracker.getChanges().every((row) => !row.touchedThisPrompt)));
	await h.pi.fire("agent_settled", h.ctx);
	const restored = harness(h.ctx.cwd, h.pi.entries); all.push(restored);
	await restored.pi.fire("session_start", restored.ctx);
	check("new persisted shape restores paths and activity", () => assert.deepEqual(restored.tracker.getChanges().map((row) => [row.path, row.touchedThisPrompt]), h.tracker.getChanges().map((row) => [row.path, row.touchedThisPrompt])));
	git("add", "base.txt"); git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "base update");
	await h.tracker.refreshRepoStates();
	check("successful status can show committed", () => assert.equal(h.tracker.getChanges().find((row) => row.path === "base.txt")?.repoState, "committed"));
	process.env.FC_FAIL_STATUS = "1";
	await h.tracker.refreshRepoStates();
	check("failed status cannot label committed", () => assert.equal(h.tracker.getChanges().find((row) => row.path === "base.txt")?.repoState, undefined));
	delete process.env.FC_FAIL_STATUS;
	const fallback = harness(join(dir, "plain")); all.push(fallback);
	process.env.PATH = join(dir, "missing-bin");
	try {
		for (const [path, text, expected] of [["newline.txt", "one\n", 1], ["no-newline.txt", "one", 1], ["blank.txt", "\n", 1], ["empty.txt", "", 0], ["two.txt", "one\ntwo\n", 2]] as const) {
			await mutate(fallback, path, text);
			check(`Git unavailable fallback line count: ${path}`, () => assert.equal(fallback.tracker.getChanges().find((row) => row.path === path)?.added, expected));
		}
		await writeFile(join(dir, "plain", "delete-me.txt"), "one\ntwo\n");
		await mutate(fallback, "delete-me.txt", null);
		check("Git unavailable fallback deletion line count", () => assert.equal(fallback.tracker.getChanges().find((row) => row.path === "delete-me.txt")?.removed, 2));
	} finally { process.env.PATH = `${fakeBin}:${oldPath}`; }
	let notifications = 0;
	h.tracker.subscribe(() => notifications++);
	await h.pi.fire("tool_call", h.ctx, { toolName: "write", input: { path: "after-clear.txt" }, toolCallId: "clear-pending" });
	h.tracker.clear();
	await writeFile(join(h.ctx.cwd, "after-clear.txt"), "not attributed\n");
	await h.pi.fire("tool_result", h.ctx, { toolName: "write", toolCallId: "clear-pending", isError: true });
	check("clear drops pending captures and persists empty set", () => { assert.equal(h.tracker.getChanges().length, 0); assert.deepEqual(h.pi.entries.at(-1).data, { items: [], promptPaths: [] }); });
	await mutate(h, "base.txt", "fresh\npost-clear\n");
	check("counts restart after clear", () => assert.equal(h.tracker.getChanges()[0].added, 1));
	process.env.FC_SLOW_STATUS = "1";
	const staleRefresh = h.tracker.refreshRepoStates();
	const shutdownCapture = h.pi.fire("tool_call", h.ctx, { toolName: "write", input: { path: "pending-shutdown.txt" }, toolCallId: "shutdown-pending" });
	await h.pi.fire("session_shutdown", h.ctx);
	const shutdownNotifications = notifications;
	await shutdownCapture;
	await staleRefresh;
	delete process.env.FC_SLOW_STATUS;
	await h.pi.fire("tool_result", h.ctx, { toolCallId: "shutdown-pending", toolName: "write" });
	await h.pi.fire("agent_settled", h.ctx);
	check("shutdown guards stale async results and clears context and subscribers", () => { assert.equal(h.tracker.getChanges().length, 0); assert.equal(h.tracker.getContext(), null); assert.equal(notifications, shutdownNotifications); });
	check("shutdown removes registry entries", () => { const registry = (globalThis as any)[Symbol.for("pi.filechanges.tracker")]; assert(![...registry.bySession.values()].includes(h.tracker)); assert.equal(registry.byOwner.get(h.pi), undefined); });
	// Compare the same real Git-backed sweep against the supplied baseline, when available.
	const baselinePath = process.env.FILECHANGES_BENCH_BASELINE;
	if (baselinePath && require("node:fs").existsSync(baselinePath)) {
		const source = (await readFile(baselinePath, "utf8"))
			.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent")))
			.replaceAll('Symbol.for("pi.filechanges.tracker")', 'Symbol.for("pi.filechanges.tracker.baseline-bench")');
		const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
		const baselineModulePath = join(dir, "baseline-tracker.mjs");
		await writeFile(baselineModulePath, transpiled);
		const baseline = await import(baselineModulePath);
		baseline.__setTmpRootsForTest([join(dir, "excluded")]);
		const text = "same content repeated to measure signature cost without extra diff work\n".repeat(30000);
		const signatureStart = performance.now();
		let signature = "";
		for (let i = 0; i < 20; i++) signature = createHash("sha256").update(Buffer.from(text)).digest("hex");
		console.log(`measurement: ${Buffer.byteLength(text)} byte SHA-256 ${(performance.now() - signatureStart).toFixed(2)}ms for 20 hashes, ${signature.length} retained hex characters per file`);
		for (const version of ["baseline", "signature"] as const) {
			const bench = version === "baseline"
				? { pi: new MockPi(), ctx: context(h.ctx.cwd), tracker: null as any }
				: harness(h.ctx.cwd);
			all.push(bench);
			if (version === "baseline") bench.tracker = baseline.getSharedFileChangesTracker(bench.pi);
			await mutate(bench, `bench-${version}-large.txt`, text);
			await bench.pi.fire("agent_settled", bench.ctx);
			const before = (await operations()).filter((line) => line.startsWith("diff ")).length;
			const started = performance.now();
			for (let i = 0; i < 3; i++) {
				await mutate(bench, `bench-${version}-trigger.txt`, `trigger ${i}\n`);
				await bench.pi.fire("agent_settled", bench.ctx);
			}
			const diffCalls = (await operations()).filter((line) => line.startsWith("diff ")).length - before;
			console.log(`measurement: ${version} 3 repeated large-file sweeps ${(performance.now() - started).toFixed(2)}ms, ${diffCalls} diff calls`);
			check(`${version} measured sweep diff count`, () => assert.equal(diffCalls, version === "baseline" ? 9 : 3));
		}
	}
	console.log(`PASS ${assertions} tracker checks`);
} finally {
	for (const item of all) await item.pi.fire("session_shutdown", item.ctx);
	__setTmpRootsForTest(null);
	process.env.PATH = oldPath;
	delete process.env.FC_FAIL_STATUS;
	delete process.env.FC_SLOW_STATUS;
	await rm(dir, { recursive: true, force: true });
}
