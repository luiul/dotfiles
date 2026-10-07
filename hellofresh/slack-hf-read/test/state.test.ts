import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, chmod, lstat, readdir, rm, rename, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ReaderError, StateStore, acquireLock, processStarted, readLockOwner, type RuntimeState } from "../src/state.ts";

const lockName = ".slack-hf-read.lock";
const recoveryName = ".slack-hf-read.lock.recovery";
const ownStart = processStarted(process.pid)!;
const commandNames = ["status", "pause", "login", "await-login", "doctor", "channels", "history", "replies", "search"];
const errorCodes = ["bad_arguments", "session_needed", "wrong_browser", "wrong_profile", "untrusted_origin", "wrong_workspace", "lock_busy", "state_invalid", "auth_lost", "paused", "network_failure", "rate_limited", "timeout", "cancelled", "ui_changed", "cleanup_failed"];
function code(expected: string): (error: unknown) => boolean {
	return (error) => { assert.ok(error instanceof ReaderError); assert.equal(error.code, expected); return true; };
}
async function fixture(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "slack-hf-state-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
function empty(): RuntimeState { return { schema_version: 1, paused: false, events: [] }; }
async function seedOwner(root: string, owner: unknown): Promise<string> {
	const path = join(root, lockName);
	await mkdir(path, { mode: 0o700 });
	await writeFile(join(path, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner), { mode: 0o600 });
	return path;
}
async function permission(path: string, expected: number): Promise<void> {
	assert.equal((await lstat(path)).mode & 0o777, expected);
}
async function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	const [code] = await once(child, "exit");
	return code;
}

test("ReaderError only exposes a whitelist message and code", () => {
	for (const name of errorCodes) {
		const error = new ReaderError(name);
		assert.equal(error.code, name);
		assert.equal(error.name, "ReaderError");
		assert.ok(error.message.length > 0);
		assert.equal(error.cause, undefined);
	}
	for (const unsafe of ["xoxc-secret", "constructor", "__proto__", "toString", "error with private query"]) {
		const error = new ReaderError(unsafe);
		assert.equal(error.code, "state_invalid");
		assert.equal(error.message, new ReaderError("state_invalid").message);
		assert.ok(!String(error).includes(unsafe));
	}
	assert.match(new ReaderError("auth_lost").message, /cause is unknown/i);
});

test("missing state gives a fresh default and a private root", async (t) => {
	const parent = await fixture(t);
	const root = join(parent, "new-root");
	const store = new StateStore(root);
	assert.deepEqual(await store.read(), empty());
	await permission(root, 0o700);
	assert.deepEqual(await readdir(root), []);
	const state = await store.read();
	state.paused = true;
	assert.deepEqual(await store.read(), empty());
});

test("write uses a private atomic replacement, not an in-place truncation", async (t) => {
	const root = await fixture(t);
	await chmod(root, 0o777);
	const store = new StateStore(root);
	await store.write(empty());
	const before = await lstat(join(root, "state.json"));
	await chmod(join(root, "state.json"), 0o666);
	await store.pause();
	await permission(root, 0o700);
	await permission(join(root, "state.json"), 0o600);
	assert.notEqual((await lstat(join(root, "state.json"))).ino, before.ino);
	assert.deepEqual(await readdir(root), ["state.json"]);
	assert.deepEqual(await store.read(), { ...empty(), paused: true, pause_reason: "user" });
});

test("malformed files and invalid known fields fail closed without echoing content", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	const at = new Date().toISOString();
	const variants: unknown[] = [
		"xoxc-SECRET {", "null", "[]", "{}", { ...empty(), schema_version: 2 }, { ...empty(), paused: "false" },
		{ ...empty(), pause_reason: "xoxc-SECRET" }, { ...empty(), events: null },
		{ ...empty(), last_auth_failure: "yesterday xoxc-SECRET" },
		{ ...empty(), browser: { pid: -1, started: ownStart, profile: root } },
		{ ...empty(), browser: { pid: process.pid, started: "xoxc-SECRET", profile: root } },
		{ ...empty(), browser: { pid: process.pid, started: ownStart, profile: "relative" } },
		{ ...empty(), browser: { pid: process.pid, started: ownStart, profile: root, target_id: "xoxc/SECRET" } },
		{ ...empty(), events: [{ at, command: "search private query", outcome: "success", duration_ms: 1 }] },
		{ ...empty(), events: [{ at, command: "search", outcome: "xoxc-SECRET", duration_ms: 1 }] },
		{ ...empty(), events: [{ at, command: "search", outcome: "success", duration_ms: -1 }] },
		{ ...empty(), events: [{ at: "2026-02-31T00:00:00.000Z", command: "search", outcome: "success", duration_ms: 1 }] },
	];
	for (const state of variants) {
		await writeFile(join(root, "state.json"), typeof state === "string" ? state : JSON.stringify(state), { mode: 0o600 });
		await assert.rejects(store.read(), (error) => {
			code("state_invalid")(error);
			assert.ok(!String(error).includes("SECRET"));
			return true;
		});
	}
	await writeFile(join(root, "state.json"), " ".repeat(128 * 1024 + 1), { mode: 0o600 });
	await assert.rejects(store.read(), code("state_invalid"));
});

test("redaction projects only allowed fields at every level", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	const at = new Date().toISOString();
	const dirty = {
		...empty(), token: "xoxc-SECRET", messages: [{ text: "private message" }], query: "private query", cause: "suspected revocation",
		browser: { pid: process.pid, started: ownStart, profile: root, target_id: "ABC123", holder_id: "HOLDER123", cookies: "private cookie" },
		events: [{ at, command: "search", outcome: "success", duration_ms: 1, channel: "PRIVATE", text: "private message" }],
	};
	const expected = { ...empty(), browser: { pid: process.pid, started: ownStart, profile: root, target_id: "ABC123", holder_id: "HOLDER123" },
		events: [{ at, command: "search", outcome: "success", duration_ms: 1 }] };
	await store.write(dirty);
	assert.deepEqual(await store.read(), expected);
	const text = await readFile(join(root, "state.json"), "utf8");
	for (const secret of ["SECRET", "private message", "private query", "private cookie", "suspected revocation", "PRIVATE"])
		assert.ok(!text.includes(secret));
	// Legacy files with unknown fields do not expose them through local status.
	await writeFile(join(root, "state.json"), JSON.stringify(dirty), { mode: 0o600 });
	assert.deepEqual(await store.read(), expected);
});

test("holder ID survives persistence and pause transitions, without storing external SSO URLs", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	const browser = { pid: process.pid, started: ownStart, profile: root, holder_id: "LOGIN_HOLDER-123" };
	await store.write({ ...empty(), browser });
	assert.deepEqual((await new StateStore(root).read()).browser, browser);
	await store.record("await-login", "auth_lost", 1);
	await store.resume();
	await store.pause();
	assert.deepEqual((await store.read()).browser, browser);
	assert.equal((await store.read()).browser?.target_id, undefined);
	const saved = await readFile(join(root, "state.json"), "utf8");
	for (const bad of [null, 7, "", "x".repeat(129), "https://sso.example/login?secret=SECRET", "holder\nSECRET"]) {
		const invalid = { ...empty(), browser: { ...browser, holder_id: bad } } as unknown as RuntimeState;
		await assert.rejects(store.write(invalid), code("state_invalid"));
		assert.equal(await readFile(join(root, "state.json"), "utf8"), saved);
		await writeFile(join(root, "state.json"), JSON.stringify(invalid), { mode: 0o600 });
		await assert.rejects(store.read(), code("state_invalid"));
		await writeFile(join(root, "state.json"), saved, { mode: 0o600 });
	}
});

test("bad writes leave the previous state intact and clean up temporary files", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	await store.write(empty());
	const before = await readFile(join(root, "state.json"), "utf8");
	await assert.rejects(store.write({ ...empty(), paused: "false" } as unknown as RuntimeState), code("state_invalid"));
	assert.equal(await readFile(join(root, "state.json"), "utf8"), before);
	assert.deepEqual(await readdir(root), ["state.json"]);
});

test("events have bounded metadata, rounded durations, and retain only the last 100", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	await Promise.all(Array.from({ length: 115 }, (_, i) => store.record("history", "success", i + 0.6)));
	const state = await store.read();
	assert.equal(state.events.length, 100);
	assert.equal(state.events[0].duration_ms, 16);
	assert.equal(state.events[99].duration_ms, 115);
	for (const event of state.events) assert.deepEqual(Object.keys(event), ["at", "command", "outcome", "duration_ms"]);
	assert.equal(state.last_successful_read, state.events[99].at);
	for (const [command, result, duration] of [
		["search secret", "success", 1], ["post", "success", 1], ["history", "invalid_auth xoxc-SECRET", 1],
		["history", "success", -1], ["history", "success", NaN], ["history", "success", Infinity],
		["history", "success", Number.MAX_SAFE_INTEGER + 1],
	] as Array<[string, string, number]>) await assert.rejects(store.record(command, result, duration), code("bad_arguments"));
	assert.deepEqual(await store.read(), state);
});

test("write and read also cap imported event rings", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	const state = { ...empty(), events: Array.from({ length: 120 }, (_, i) => ({ at: new Date().toISOString(), command: "channels", outcome: "success", duration_ms: i })) };
	await store.write(state);
	assert.equal((await store.read()).events[0].duration_ms, 20);
	await writeFile(join(root, "state.json"), JSON.stringify(state), { mode: 0o600 });
	assert.equal((await store.read()).events.length, 100);
});

test("known commands and outcome codes are accepted without counting diagnostics as reads", async (t) => {
	const store = new StateStore(await fixture(t));
	for (const command of commandNames) {
		await store.record(command, "success", 0.49);
		const state = await store.read();
		assert.equal(state.events.at(-1)?.duration_ms, 0);
		if (["status", "pause", "login", "await-login", "doctor"].includes(command)) assert.equal(state.last_successful_read, undefined);
		else assert.equal(state.last_successful_read, state.events.at(-1)?.at);
	}
	for (const result of errorCodes) await store.record("history", result, 1);
	const state = await store.read();
	assert.deepEqual(state.events.slice(-errorCodes.length).map(event => event.outcome), errorCodes);
});

test("auth failure persistently pauses all later reads until explicit resume", async (t) => {
	const root = await fixture(t);
	const store = new StateStore(root);
	await store.record("doctor", "auth_lost", 1);
	let state = await new StateStore(root).read();
	assert.equal(state.paused, true);
	assert.equal(state.pause_reason, "auth_lost");
	assert.equal(state.last_auth_failure, state.events[0].at);
	assert.equal(state.last_successful_read, undefined);
	await store.record("await-login", "success", 1);
	await store.record("channels", "success", 1);
	state = await store.read();
	assert.equal(state.paused, true);
	assert.equal(state.last_auth_failure, state.events[0].at);
	assert.equal(state.last_successful_read, state.events.at(-1)?.at);
	await store.resume();
	state = await new StateStore(root).read();
	assert.equal(state.paused, false);
	assert.equal(state.pause_reason, undefined);
	assert.equal(state.last_auth_failure, state.events[0].at);
	assert.equal(state.events.length, 3);
	await store.pause();
	assert.equal((await store.read()).pause_reason, "user");
	await store.resume();
	assert.equal((await store.read()).paused, false);
});

test("state root and state file symlinks are rejected without touching their targets", async (t) => {
	const parent = await fixture(t);
	const outside = join(parent, "outside");
	await mkdir(outside, { mode: 0o755 });
	const root = join(parent, "linked-root");
	await symlink(outside, root);
	await assert.rejects(new StateStore(root).read(), code("state_invalid"));
	await assert.rejects(new StateStore(root).write(empty()), code("state_invalid"));
	await permission(outside, 0o755);
	const realRoot = join(parent, "real-root");
	await mkdir(realRoot, { mode: 0o700 });
	const target = join(outside, "secret");
	await writeFile(target, "xoxc-SECRET", { mode: 0o644 });
	await symlink(target, join(realRoot, "state.json"));
	await assert.rejects(new StateStore(realRoot).read(), code("state_invalid"));
	await assert.rejects(new StateStore(realRoot).write(empty()), code("state_invalid"));
	assert.equal(await readFile(target, "utf8"), "xoxc-SECRET");
	await permission(target, 0o644);
});

test("hardlinked files and non-file destinations are rejected", async (t) => {
	const root = await fixture(t);
	const target = join(root, "secret");
	await writeFile(target, JSON.stringify(empty()), { mode: 0o644 });
	await link(target, join(root, "state.json"));
	await assert.rejects(new StateStore(root).read(), code("state_invalid"));
	await assert.rejects(new StateStore(root).write(empty()), code("state_invalid"));
	await permission(target, 0o644);
	await rm(join(root, "state.json"));
	await mkdir(join(root, "state.json"));
	await assert.rejects(new StateStore(root).write(empty()), code("state_invalid"));
});

test("directory and file owner mismatches fail closed", async (t) => {
	const root = await fixture(t);
	const uid = process.getuid!();
	const store = new StateStore(root);
	await store.write(empty());
	const mock = t.mock.method(process, "getuid", () => uid + 1);
	await assert.rejects(store.read(), code("state_invalid"));
	await assert.rejects(acquireLock(root), code("state_invalid"));
	mock.mock.restore();
	// Directory checks pass before the file ownership check. Simulate a file
	// belonging to another uid without requiring privileged chown in CI.
	let checks = 0;
	t.mock.method(process, "getuid", () => ++checks <= 3 ? uid : uid + 1);
	await assert.rejects(store.read(), code("state_invalid"));
	assert.equal(checks, 4);
});

test("ps start time is a synchronous trimmed local identity", () => {
	assert.equal(processStarted(process.pid), execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
	for (const pid of [0, -1, NaN, 1.1, 2_147_483_648]) assert.equal(processStarted(pid), undefined);
});

test("acquireLock has one private owner and release is idempotent", async (t) => {
	const root = await fixture(t);
	await chmod(root, 0o755);
	const lock = await acquireLock(root);
	await permission(root, 0o700);
	await permission(join(root, lockName), 0o700);
	await permission(join(root, lockName, "owner.json"), 0o600);
	const owner = JSON.parse(await readFile(join(root, lockName, "owner.json"), "utf8"));
	assert.deepEqual(Object.keys(owner), ["pid", "started", "token"]);
	assert.equal(owner.pid, process.pid);
	assert.equal(owner.started, ownStart);
	assert.match(owner.token, /^[a-f0-9]{64}$/);
	assert.deepEqual(await readLockOwner(root), { pid: process.pid, started: ownStart, alive: true });
	await assert.rejects(acquireLock(root), code("lock_busy"));
	assert.ok(!(await readdir(root)).includes(recoveryName));
	await Promise.all([lock.release(), lock.release(), lock.release()]);
	assert.equal(await readLockOwner(root), null);
	assert.deepEqual(await readdir(root), []);
	await lock.release();
});

test("simultaneous acquisitions allow exactly one owner and no lock stealing", async (t) => {
	const root = await fixture(t);
	const results = await Promise.allSettled(Array.from({ length: 32 }, () => acquireLock(root)));
	const winners = results.filter(result => result.status === "fulfilled");
	assert.equal(winners.length, 1);
	for (const result of results) if (result.status === "rejected") code("lock_busy")(result.reason);
	assert.equal((await readLockOwner(root))?.alive, true);
	if (winners[0].status === "fulfilled") await winners[0].value.release();
	assert.deepEqual(await readdir(root), []);
});

test("separate CLI processes cannot enter an owned session concurrently", async (t) => {
	const root = await fixture(t);
	const source = new URL("../src/state.ts", import.meta.url).href;
	const children = Array.from({ length: 6 }, () => spawn(process.execPath, ["--input-type=module", "-e", `
		import { acquireLock, ReaderError } from ${JSON.stringify(source)};
		process.send('ready');
		process.once('message', async () => {
			try {
				const lock = await acquireLock(${JSON.stringify(root)});
				process.send('owned');
				process.once('message', async () => { await lock.release(); process.exit(0); });
			} catch (error) { process.send(error instanceof ReaderError ? error.code : 'unsafe-error'); process.exit(0); }
		});
	`], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
	t.after(() => { for (const child of children) child.kill(); });
	await Promise.all(children.map(child => once(child, "message").then(([message]) => assert.equal(message, "ready"))));
	const results = children.map(child => once(child, "message").then(([message]) => message));
	for (const child of children) child.send("go");
	const outcomes = await Promise.all(results);
	assert.equal(outcomes.filter(value => value === "owned").length, 1);
	assert.equal(outcomes.filter(value => value === "lock_busy").length, 5);
	children[outcomes.indexOf("owned")].send("release");
	assert.deepEqual(await Promise.all(children.map(child => childExit(child))), Array(6).fill(0));
	assert.equal(await readLockOwner(root), null);
});

test("crashed owner is recovered, but a live owner never is", async (t) => {
	const root = await fixture(t);
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(() => child.kill());
	await once(child, "spawn");
	const started = processStarted(child.pid!)!;
	assert.ok(started);
	await seedOwner(root, { pid: child.pid, started, token: "crashed-owner" });
	await assert.rejects(acquireLock(root), code("lock_busy"));
	child.kill("SIGKILL");
	await childExit(child);
	assert.deepEqual(await readLockOwner(root), { pid: child.pid, started, alive: false });
	const lock = await acquireLock(root);
	assert.deepEqual(await readLockOwner(root), { pid: process.pid, started: ownStart, alive: true });
	await lock.release();
});

test("PID reuse allows recovery only when the recorded process start differs", async (t) => {
	const root = await fixture(t);
	const staleStart = "Mon Jan  1 00:00:00 2001";
	assert.notEqual(staleStart, ownStart);
	await seedOwner(root, { pid: process.pid, started: staleStart, token: "reused-pid" });
	assert.equal((await readLockOwner(root))?.alive, false);
	const results = await Promise.allSettled(Array.from({ length: 20 }, () => acquireLock(root)));
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	for (const result of results) {
		if (result.status === "fulfilled") await result.value.release();
		else code("lock_busy")(result.reason);
	}
	assert.deepEqual(await readdir(root), []);
});

test("unknown, missing, and malformed owners are never stolen", async (t) => {
	for (const owner of [undefined, "{ xoxc-SECRET", {}, { pid: process.pid, started: ownStart },
		{ pid: -1, started: ownStart, token: "owner" }, { pid: process.pid, started: "not a start", token: "owner" },
		{ pid: process.pid, started: "xxx xxx 99 99:99:99 9999", token: "owner" },
		{ pid: process.pid, started: "Mon Feb 31 00:00:00 2026", token: "owner" },
		{ pid: process.pid, started: "Mon Jan  1 00:00:00 2026", token: "owner" },
		{ pid: process.pid, started: ownStart, token: "unsafe/token" }]) {
		const root = await fixture(t);
		if (owner === undefined) await mkdir(join(root, lockName), { mode: 0o700 });
		else await seedOwner(root, owner);
		assert.equal(await readLockOwner(root), null);
		const before = await readdir(join(root, lockName));
		await assert.rejects(acquireLock(root), code("lock_busy"));
		assert.deepEqual(await readdir(join(root, lockName)), before);
		assert.ok(!(await readdir(root)).includes(recoveryName));
	}
});

test("lock owner and directory permission mismatches fail without modifying another lock", async (t) => {
	for (const target of ["directory", "file"]) {
		const root = await fixture(t);
		const path = await seedOwner(root, { pid: process.pid, started: ownStart, token: "owner" });
		const exposed = target === "directory" ? path : join(path, "owner.json");
		await chmod(exposed, target === "directory" ? 0o755 : 0o644);
		await assert.rejects(acquireLock(root), code("state_invalid"));
		await assert.rejects(readLockOwner(root), code("state_invalid"));
		await permission(exposed, target === "directory" ? 0o755 : 0o644);
	}
});

test("release and rejected acquisition can overlap without stranding the current owner", async (t) => {
	const root = await fixture(t);
	for (let i = 0; i < 12; i++) {
		const current = await acquireLock(root);
		const results = await Promise.allSettled([current.release(), acquireLock(root)]);
		assert.equal(results[0].status, "fulfilled");
		const contender = results[1];
		if (contender.status === "fulfilled") await contender.value.release();
		else code("lock_busy")(contender.reason);
		assert.deepEqual(await readdir(root), []);
	}
});

test("a leftover recovery directory blocks acquisition, including otherwise stale owners", async (t) => {
	const root = await fixture(t);
	await seedOwner(root, { pid: process.pid, started: "Mon Jan  1 00:00:00 2001", token: "old" });
	await mkdir(join(root, recoveryName), { mode: 0o700 });
	const before = await readFile(join(root, lockName, "owner.json"), "utf8");
	await assert.rejects(acquireLock(root), code("lock_busy"));
	assert.equal(await readFile(join(root, lockName, "owner.json"), "utf8"), before);
	assert.ok((await readdir(root)).includes(recoveryName));
});

test("release never removes a replacement lock or a changed owner token", async (t) => {
	const root = await fixture(t);
	const first = await acquireLock(root);
	const path = join(root, lockName, "owner.json");
	const old = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...old, token: "other-owner" }), { mode: 0o600 });
	await first.release();
	assert.equal(JSON.parse(await readFile(path, "utf8")).token, "other-owner");
	await rename(join(root, lockName), join(root, "saved-lock"));
	const second = await acquireLock(root);
	const replacement = await readFile(path, "utf8");
	await first.release();
	assert.equal(await readFile(path, "utf8"), replacement);
	await second.release();
	// A same-token replacement is still not the original directory or file.
	const third = await acquireLock(root);
	const thirdOwner = JSON.parse(await readFile(path, "utf8"));
	await rename(join(root, lockName), join(root, "saved-third"));
	await seedOwner(root, thirdOwner);
	await third.release();
	assert.equal(await readFile(path, "utf8"), JSON.stringify(thirdOwner));
});

test("release checks the owner file identity as well as its token", async (t) => {
	const root = await fixture(t);
	const lock = await acquireLock(root);
	const path = join(root, lockName, "owner.json");
	const owner = await readFile(path, "utf8");
	await rename(path, join(root, "saved-owner"));
	await writeFile(path, owner, { mode: 0o600 });
	await lock.release();
	assert.equal(await readFile(path, "utf8"), owner);
});

test("lock directory, owner file, recovery directory, and root reject symlinks", async (t) => {
	for (const targetName of ["root", "lock", "owner", "recovery"]) {
		const parent = await fixture(t);
		const target = join(parent, "outside");
		await mkdir(target, { mode: 0o755 });
		const root = join(parent, "root");
		if (targetName === "root") await symlink(target, root);
		else {
			await mkdir(root, { mode: 0o700 });
			if (targetName === "lock") await symlink(target, join(root, lockName));
			if (targetName === "recovery") await symlink(target, join(root, recoveryName));
			if (targetName === "owner") {
				await mkdir(join(root, lockName), { mode: 0o700 });
				await writeFile(join(target, "secret"), "xoxc-SECRET", { mode: 0o644 });
				await symlink(join(target, "secret"), join(root, lockName, "owner.json"));
			}
		}
		await assert.rejects(acquireLock(root), code("state_invalid"));
		await permission(target, 0o755);
		if (targetName !== "recovery") await assert.rejects(readLockOwner(root), code("state_invalid"));
		if (targetName === "owner") assert.equal(await readFile(join(target, "secret"), "utf8"), "xoxc-SECRET");
	}
});

test("unknown extra lock files are never recursively removed during recovery or release", async (t) => {
	const root = await fixture(t);
	const path = await seedOwner(root, { pid: process.pid, started: "Mon Jan  1 00:00:00 2001", token: "old" });
	await writeFile(join(path, "unknown"), "private", { mode: 0o600 });
	const before = await readFile(join(path, "owner.json"), "utf8");
	await assert.rejects(acquireLock(root), code("state_invalid"));
	assert.equal(await readFile(join(path, "owner.json"), "utf8"), before);
	assert.equal(await readFile(join(path, "unknown"), "utf8"), "private");
	assert.ok(!(await readdir(root)).includes(recoveryName));
	await rm(path, { recursive: true });
	const lock = await acquireLock(root);
	await writeFile(join(path, "unknown"), "private", { mode: 0o600 });
	const currentOwner = await readFile(join(path, "owner.json"), "utf8");
	await assert.rejects(lock.release(), code("cleanup_failed"));
	assert.equal(await readFile(join(path, "owner.json"), "utf8"), currentOwner);
	assert.equal(await readFile(join(path, "unknown"), "utf8"), "private");
});

test("uncertain process identity is not treated as stale when ps fails", async (t) => {
	const root = await fixture(t);
	await seedOwner(root, { pid: process.pid, started: ownStart, token: "live" });
	const path = process.env.PATH;
	process.env.PATH = join(root, "no-commands");
	try {
		assert.equal(processStarted(process.pid), undefined);
		assert.equal((await readLockOwner(root))?.alive, true);
		await assert.rejects(acquireLock(root), code("lock_busy"));
	} finally { process.env.PATH = path; }
});
