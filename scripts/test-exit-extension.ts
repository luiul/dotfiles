import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import exitExtension from "../pi/.pi/agent/extensions/exit.ts";

let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
let registrations = 0;
exitExtension(new Proxy({
	registerCommand(name: string, options: typeof command) {
		assert.equal(name, "exit");
		registrations++;
		command = options;
	},
}, {
	get(target, name) {
		assert.equal(name, "registerCommand", `Unexpected runtime resource: ${String(name)}`);
		return Reflect.get(target, name);
	},
}) as unknown as ExtensionAPI);
assert.equal(registrations, 1);
assert.ok(command?.description?.includes("exit Pi cleanly"));
console.log("PASS registers only /exit, no hooks, tools, timers, or runtime services");

for (const state of ["idle", "streaming", "tool", "retry", "compaction", "queued"]) {
	const calls: string[] = [];
	let settle!: () => void;
	const idle = new Promise<void>(resolve => { settle = resolve; });
	const ctx = {
		abort() { calls.push("abort"); },
		waitForIdle() { calls.push("wait"); return idle; },
		shutdown() { calls.push("shutdown"); },
	} as unknown as ExtensionCommandContext;
	const run = command!.handler("", ctx);
	assert.deepEqual(calls, ["abort", "wait"], `${state}: shutdown before idle`);
	settle();
	await run;
	assert.deepEqual(calls, ["abort", "wait", "shutdown"]);
	console.log(`PASS ${state}: abort, wait for idle, then graceful shutdown`);
}

for (const failing of ["abort", "wait"]) {
	const calls: string[] = [];
	const error = new Error("fixture failure");
	const ctx = {
		abort() { calls.push("abort"); if (failing === "abort") throw error; },
		async waitForIdle() { calls.push("wait"); throw error; },
		shutdown() { calls.push("shutdown"); },
	} as unknown as ExtensionCommandContext;
	await assert.rejects(command!.handler("", ctx), error);
	assert(!calls.includes("shutdown"), "Must not force exit when cancellation fails");
}
console.log("PASS cancellation errors reach Pi's command error handling, without forced exit");

let shutdowns = 0;
const ctx = { abort() {}, async waitForIdle() {}, shutdown() { shutdowns++; } } as unknown as ExtensionCommandContext;
await command!.handler("", ctx);
await command!.handler("", ctx);
assert.equal(shutdowns, 2);
console.log("PASS repeated invocations use native idempotent shutdown, no retained extension state");
