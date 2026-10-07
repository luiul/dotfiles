import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs, locationKind, readURL } from "../src/args.ts";
import { run, type Dependencies } from "../src/main.ts";
import { ReaderError } from "../src/state.ts";

function harness() {
	const calls: string[] = [];
	const outputs: any[] = [];
	let paused = false;
	const deps = {
		root: "/unused", profile: "/unused",
		store: {
			async read() { calls.push("state"); return { schema_version: 1, paused, events: [] }; },
			async record(_cmd: string, outcome: string) { calls.push(`record:${outcome}`); if (outcome === "auth_lost") paused = true; },
			async resume() { calls.push("resume"); paused = false; },
			async pause() { calls.push("pause"); paused = true; },
		},
		async lock() { calls.push("lock"); return { async release() { calls.push("release"); } }; },
		async acquire() { calls.push("attach"); return { page: {}, check() {}, async close(failed: boolean) { calls.push(`close:${failed}`); } }; },
		async login() { calls.push("login"); },
		async read() { calls.push("read"); return { schema_version: 1, ok: true }; },
		async verify() { calls.push("verify"); },
		output(value: unknown) { outputs.push(value); },
	} as unknown as Dependencies;
	return { deps, calls, outputs, setPaused(value: boolean) { paused = value; } };
}

for (const argv of [[], ["unknown"], ["history"], ["doctor", "--limit", "1"], ["history", "wrong"],
	["channels", "--limit", "0"], ["channels", "--limit", "101"], ["channels", "--limit", "2.5"],
	["channels", "--limit"], ["channels", "--cursor", "foo"], ["channels", "--limit", "1", "--limit", "2"],
	["history", "C0123456789", "--after", "2026-02-30"], ["history", "C0123456789", "--after", "2026-10-02", "--before", "2026-10-01"],
	["replies", "C0123456789", "1.2"], ["search", ""], ["search", "x".repeat(501)], ["status", "extra"]]) {
	test(`invalid arguments: ${argv[0] ?? "missing"} (${JSON.stringify(argv).length})`, async () => {
		const h = harness();
		assert.equal(await run(argv, h.deps), 2);
		assert.deepEqual(h.calls, []);
		assert.equal(h.outputs[0].error, "bad_arguments");
	});
}

test("URLs and trusted workspace boundaries", () => {
	assert.equal(readURL(parseArgs(["search", "in:general a & b"])), "https://app.slack.com/client/T02AGMUUR/search?q=in%3Ageneral%20a%20%26%20b");
	assert.equal(locationKind("https://app.slack.com/client/T02AGMUUR/C0123456789"), "workspace");
	assert.equal(locationKind("https://app.slack.com/client/TOTHER"), "wrong_workspace");
	for (const url of ["http://app.slack.com/client/T02AGMUUR", "https://app.slack.com.evil/client/T02AGMUUR", "https://u:p@app.slack.com/client/T02AGMUUR", "https://app.slack.com:9223/client/T02AGMUUR"]) assert.equal(locationKind(url), "untrusted_origin");
	assert.equal(locationKind("https://slack.com/workspace-signin"), "login");
});

test("success disconnects then records then unlocks", async () => {
	const h = harness();
	assert.equal(await run(["channels", "--limit", "1"], h.deps), 0);
	assert.deepEqual(h.calls, ["lock", "state", "attach", "read", "close:false", "record:success", "release"]);
});

for (const code of ["auth_lost", "rate_limited", "network_failure", "timeout", "ui_changed", "wrong_workspace", "untrusted_origin"]) {
	test(`${code} cleans owned resources and unlocks`, async () => {
		const h = harness();
		h.deps.read = async () => { throw new ReaderError(code); };
		assert.equal(await run(["channels"], h.deps), 1);
		assert.ok(h.calls.indexOf("close:true") < h.calls.indexOf("release"));
		assert.equal(h.outputs[0].error, code);
		if (code === "auth_lost") {
			h.calls.length = 0;
			assert.equal(await run(["channels"], h.deps), 1);
			assert.ok(!h.calls.includes("attach"));
			assert.equal(h.outputs[1].error, "paused");
		}
	});
}

test("paused doctor cannot clear pause, explicit verification can", async () => {
	const h = harness(); h.setPaused(true);
	assert.equal(await run(["doctor"], h.deps), 1);
	assert.ok(!h.calls.includes("attach"));
	h.calls.length = 0;
	assert.equal(await run(["await-login"], h.deps), 0);
	assert.ok(h.calls.includes("resume"));
	assert.ok(h.calls.includes("lock"));
});

test("failed explicit verification stays paused", async () => {
	const h = harness(); h.setPaused(true);
	h.deps.verify = async () => { throw new ReaderError("auth_lost"); };
	assert.equal(await run(["await-login"], h.deps), 1);
	assert.ok(!h.calls.includes("resume"));
});

test("missing browser never launches a fallback", async () => {
	const h = harness(); h.deps.acquire = async () => { throw new ReaderError("session_needed"); };
	assert.equal(await run(["history", "C0123456789"], h.deps), 1);
	assert.ok(!h.calls.includes("login"));
	assert.ok(h.calls.includes("release"));
});

test("lock contention does not attach", async () => {
	const h = harness(); h.deps.lock = async () => { throw new ReaderError("lock_busy"); };
	assert.equal(await run(["await-login"], h.deps), 1);
	assert.deepEqual(h.calls, []);
});

test("raw errors never leak credentials or message text", async () => {
	const h = harness(); h.deps.read = async () => { throw new Error("xoxc-secret-value token=secret-value Sensitive message"); };
	assert.equal(await run(["channels"], h.deps), 1);
	assert.doesNotMatch(JSON.stringify(h.outputs), /secret-value|Sensitive message|xoxc/);
});

test("cancellation closes the owned tab before lock release", async () => {
	const h = harness(); const controller = new AbortController();
	h.deps.read = async () => { controller.abort(); return new Promise(() => {}); };
	assert.equal(await run(["channels"], h.deps, controller.signal), 130);
	assert.ok(h.calls.indexOf("close:true") < h.calls.indexOf("release"));
	assert.equal(h.outputs[0].error, "cancelled");
});

test("deadline closes owned resources without retry", async () => {
	const h = harness(); h.deps.deadlineMs = 20;
	let timer: ReturnType<typeof setTimeout> | undefined;
	h.deps.read = async () => new Promise(resolve => { timer = setTimeout(() => resolve({} as any), 1_000); });
	try {
		assert.equal(await run(["channels"], h.deps), 1);
		assert.equal(h.outputs[0].error, "timeout");
		assert.ok(h.calls.includes("close:true"));
		assert.equal(h.calls.filter(c => c === "attach").length, 1);
	} finally { clearTimeout(timer); }
});

test("auth loss is persisted before cleanup failure", async () => {
	const h = harness();
	h.deps.read = async () => { throw new ReaderError("auth_lost"); };
	h.deps.acquire = async () => ({ page: {} as any, check() {}, async close() { h.calls.push("close:failed"); throw new Error("cleanup"); } });
	assert.equal(await run(["channels"], h.deps), 1);
	assert.ok(h.calls.indexOf("record:auth_lost") < h.calls.indexOf("close:failed"));
	assert.equal(h.outputs[0].error, "auth_lost");
	assert.equal(await run(["channels"], h.deps), 1);
	assert.equal(h.outputs[1].error, "paused");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	test(`${signal} returns cancellation after owned cleanup`, async () => {
		const source = `
			import { run } from './src/main.ts';
			const controller = new AbortController();
			process.on('${signal}', () => controller.abort());
			const timer = setInterval(() => {}, 1000);
			const output = [];
			const deps = { root:'/unused',profile:'/unused',
				store:{read:async()=>({paused:false,events:[]}),record:async()=>output.push('record')},
				lock:async()=>({release:async()=>output.push('release')}),
				acquire:async()=>({check(){},page:{},close:async()=>output.push('close')}),
				read:async()=>{console.log('READY');return new Promise(()=>{});},
				output:v=>console.log(JSON.stringify({v,output}))};
			process.exitCode = await run(['channels'], deps, controller.signal);
			clearInterval(timer);
		`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
		const exited = once(child, "exit");
		let stdout = "";
		child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("READY") && !stdout.includes('"v"')) child.kill(signal); });
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		try {
			const [code] = await exited;
			assert.equal(code, 130);
			const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
			assert.equal(result.v.error, "cancelled");
			assert.deepEqual(result.output, ["close", "record", "release"]);
		} finally { clearTimeout(timer); }
	});
}

test("invalid CLI arguments make no state or profile directories", async () => {
	const dir = await mkdtemp(join(tmpdir(), "slack-cli-test-"));
	try {
		const result = spawnSync(process.execPath, ["src/main.ts", "channels", "--cursor", "x"], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, SLACK_HF_STATE_DIR: join(dir, "state"), SLACK_HF_PROFILE_DIR: join(dir, "profile") } });
		assert.equal(result.status, 2);
		assert.equal(JSON.parse(result.stdout).error, "bad_arguments");
		assert.deepEqual(await readdir(dir), []);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
