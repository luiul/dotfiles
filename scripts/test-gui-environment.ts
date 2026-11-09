import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreGuiEnvironment as restoreEnvironment } from "../pi/.pi/agent/extensions/gui-environment.ts";

const root = mkdtempSync(join(tmpdir(), "pi-gui-env-"));
const agent = join(root, "agent");
const bin = join(agent, "bin");
const runtime = join(root, "node", "bin", "node");
const dotenv = join(root, ".env");
const restoreGuiEnvironment = (pi: Parameters<typeof restoreEnvironment>[0], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, directory: string, executable: string) =>
	restoreEnvironment(pi, env, platform, directory, executable, dotenv);
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
let calls = 0;
const pi = { exec: async (command: string, args: string[], options?: { timeout?: number }) => {
	calls++;
	assert.equal(command, "/bin/launchctl");
	assert.deepEqual(args, ["getenv", "AI_MODEL_ROUTER_API_KEY"]);
	assert.equal(options?.timeout, 2000);
	return { code: 0, stdout: "fixture-key\n", stderr: "", killed: false };
} };
try {
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
	await restoreGuiEnvironment(pi, env, "darwin", agent, runtime);
	assert.equal(env.AI_MODEL_ROUTER_API_KEY, "fixture-key");
	assert.equal(env.PATH, `${bin}:${join(root, "node", "bin")}:/usr/bin:/bin`);
	await restoreGuiEnvironment(pi, env, "darwin", agent, runtime);
	assert.equal(calls, 1);
	assert.equal(new Set(env.PATH?.split(":")).size, 4);
	console.log("PASS missing GUI key and managed PATH restored; repeated load is idempotent");

	const inherited = { PATH: "/bin", AI_MODEL_ROUTER_API_KEY: "inherited" };
	await restoreGuiEnvironment(pi, inherited, "darwin", agent, runtime);
	assert.equal(inherited.AI_MODEL_ROUTER_API_KEY, "inherited");
	assert.equal(calls, 1);
	for (const result of [
		{ code: 1, stdout: "ignored" }, { code: 0, stdout: "   " },
		{ code: 0, stdout: "ignored", killed: true }, { code: 0, stdout: "ignored", truncated: true },
	]) {
		const missing: NodeJS.ProcessEnv = { PATH: "/bin" };
		await restoreGuiEnvironment({ exec: async () => ({ stderr: "", ...result }) }, missing, "darwin", agent, runtime);
		assert.equal(missing.AI_MODEL_ROUTER_API_KEY, undefined);
	}
	await restoreGuiEnvironment({ exec: async () => { throw Error("fixture failure"); } }, {}, "darwin", agent, runtime);
	console.log("PASS inherited key preserved; empty, failed, killed and truncated lookups ignored");

	const raced: NodeJS.ProcessEnv = {};
	await restoreGuiEnvironment({ exec: async () => {
		raced.AI_MODEL_ROUTER_API_KEY = "new-inherited";
		return { code: 0, stdout: "stale", stderr: "" };
	} }, raced, "darwin", agent, runtime);
	assert.equal(raced.AI_MODEL_ROUTER_API_KEY, "new-inherited");
	const managed = { PI_MANAGED_INSTALL_ROOT: join(agent, "install"), PATH: "/bin" };
	await restoreGuiEnvironment(pi, managed, "linux", join(root, "other-agent"), runtime);
	assert.equal(managed.PATH, `${bin}:${join(root, "node", "bin")}:/bin`);
	assert.equal(calls, 1);
	const windows = { PATH: "C:\\Windows" };
	await restoreGuiEnvironment(pi, windows, "win32", agent, runtime);
	assert.equal(windows.PATH, "C:\\Windows");
	chmodSync(join(bin, "pi"), 0o600);
	const absent = { PATH: "/bin", AI_MODEL_ROUTER_API_KEY: "inherited" };
	await restoreGuiEnvironment(pi, absent, "darwin", agent, runtime);
	assert.equal(absent.PATH, "/bin");
	console.log("PASS managed install identity, credential race, platform guards and absent launcher");
	const noGui = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const restored: NodeJS.ProcessEnv = {};
	writeFileSync(dotenv, 'export AI_MODEL_ROUTER_API_KEY="dotenv-fixture"\nOTHER_KEY=unused\n', { mode: 0o600 });
	await restoreGuiEnvironment(noGui, restored, "darwin", agent, runtime);
	assert.equal(restored.AI_MODEL_ROUTER_API_KEY, "dotenv-fixture");
	assert.equal(restored.OTHER_KEY, undefined);
	writeFileSync(dotenv, `AI_MODEL_ROUTER_API_KEY=$(touch ${join(root, "must-not-exist")})\n`);
	await restoreGuiEnvironment(noGui, {}, "darwin", agent, runtime);
	assert.equal((await import("node:fs")).existsSync(join(root, "must-not-exist")), false);
	console.log("PASS dotenv fallback imports only the router key and executes no shell code");
} finally {
	rmSync(root, { recursive: true, force: true });
}
