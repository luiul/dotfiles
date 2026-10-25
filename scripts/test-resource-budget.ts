import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { DEFAULT_EXEC_TIMEOUT_MS, enforceExecutionBudget, verifyResourcePatch } from "../pi/.pi/agent/extensions/resource-budget.ts";

let assertions = 0;
function check(name: string, fn: () => void) { fn(); assertions++; console.log(`PASS ${name}`); }
const dir = mkdtempSync(join(tmpdir(), "resource-budget-test-"));
try {
	check("missing patch fails closed", () => assert.match(verifyResourcePatch(dir)!, /missing/));
	const files: Record<string, string> = {};
	for (const file of ["build/adapters/pi/mcp-bridge.js", "build/executor.js", "build/server.js", "build/lifecycle.js", "server.bundle.mjs"]) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), "fixture");
		files[file] = createHash("sha256").update("fixture").digest("hex");
	}
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.169" }));
	writeFileSync(join(dir, ".pi-resource-patch.json"), JSON.stringify({ revision: "context-mode-resources-v2", patchVersion: 1, version: "1.0.169", files }));
	check("verified files accepted", () => assert.equal(verifyResourcePatch(dir), undefined));
	writeFileSync(join(dir, "build/executor.js"), "drift");
	check("source drift rejected", () => assert.match(verifyResourcePatch(dir)!, /drift/));
	for (const tool of ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]) {
		const input: Record<string, unknown> = {};
		check(`${tool} default deadline`, () => { assert.equal(enforceExecutionBudget(tool, input), undefined); assert.equal(input.timeout, DEFAULT_EXEC_TIMEOUT_MS); });
	}
	check("explicit long build deadline preserved", () => {
		const input = { timeout: 1_800_000 }; assert.equal(enforceExecutionBudget("ctx_execute", input), undefined); assert.equal(input.timeout, 1_800_000);
	});
	for (const timeout of [0, -1, Infinity, NaN, "120000", 2_147_483_648]) {
		check(`invalid timeout ${timeout} blocked`, () => assert.ok(enforceExecutionBudget("ctx_execute", { timeout })));
	}
	check("unbounded detached work blocked", () => assert.match(enforceExecutionBudget("ctx_execute", { background: true })!, /explicit/));
	check("explicit detached work accepted", () => assert.equal(enforceExecutionBudget("ctx_execute", { timeout: 5000, background: true }), undefined));
	check("non-execution inputs untouched", () => {
		const input = {}; assert.equal(enforceExecutionBudget("ctx_search", input), undefined); assert.deepEqual(input, {});
	});
	{
		const name = "hook fails closed without patch";
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const handlers = new Map<string, Function>();
			extension({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
			assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: {} }), undefined);
			const result = await handlers.get("tool_call")!({ toolName: "ctx_execute", input: {} });
			assert.equal(result.block, true);
			assert.match(result.reason, /patch/);
			assertions++;
			console.log(`PASS ${name}`);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
		}
	}
	{
		const agent = join(dir, "agent");
		const pkg = join(agent, "npm/node_modules/context-mode");
		writeFileSync(join(dir, "build/executor.js"), "fixture");
		mkdirSync(pkg, { recursive: true });
		for (const file of ["build", "package.json", ".pi-resource-patch.json", "server.bundle.mjs"]) cpSync(join(dir, file), join(pkg, file), { recursive: true });
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const handlers = new Map<string, Function>();
			extension({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
			await handlers.get("before_agent_start")!({});
			assert.equal(await handlers.get("tool_call")!({ toolName: "ctx_execute", input: {} }), undefined);
			writeFileSync(join(pkg, "server.bundle.mjs"), "changed after run start");
			const blocked = await handlers.get("tool_call")!({ toolName: "ctx_execute", input: {} });
			check("in-turn package replacement fails closed", () => { assert.equal(blocked.block, true); assert.match(blocked.reason, /drift/); });
			writeFileSync(join(pkg, "server.bundle.mjs"), "fixture");
			check("repaired patch works without cached refusal", () => assert.equal(verifyResourcePatch(pkg), undefined));
			assert.equal(await handlers.get("tool_call")!({ toolName: "ctx_execute", input: {} }), undefined);
			const marker = readFileSync(join(pkg, ".pi-resource-patch.json"), "utf8");
			writeFileSync(join(pkg, ".pi-resource-patch.json"), marker.replace("resources-v2", "resources-v1"));
			check("superseded revision requires upgrade", () => assert.match(verifyResourcePatch(pkg)!, /version/));
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
		}
	}
	console.log(`ALL PASS (${assertions} checks)`);
} finally { rmSync(dir, { recursive: true, force: true }); }
