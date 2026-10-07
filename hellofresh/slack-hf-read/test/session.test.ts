import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, stat, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAVE, prepareProfile, validBrowserCommand, validDebugEndpoint, acquireSession, closeAcquired } from "../src/session.ts";
import { StateStore } from "../src/state.ts";

const profile = "/tmp/slack-profile";
const flags = `--user-data-dir=${profile} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223`;

test("browser command requires headed Beta, exact profile, and loopback", () => {
	assert.equal(validBrowserCommand(`${BRAVE} ${flags} https://hellofresh.slack.com/`, profile), true);
	for (const command of [
		`${BRAVE} ${flags} --headless`, `${BRAVE} ${flags} --user-agent=custom`,
		`${BRAVE} ${flags} --disable-blink-features=AutomationControlled`,
		`${BRAVE} ${flags.replace("127.0.0.1", "0.0.0.0")}`, `${BRAVE} ${flags.replace(profile, `${profile}-other`)}`,
		`${BRAVE} ${flags} --remote-debugging-address=0.0.0.0`, `${BRAVE} ${flags} --user-data-dir=/other`,
		`/Applications/Brave Browser.app/Contents/MacOS/Brave Browser ${flags}`,
	]) assert.equal(validBrowserCommand(command, profile), false);
});

test("debug endpoint is localhost websocket only", () => {
	assert.equal(validDebugEndpoint("ws://127.0.0.1:9223/devtools/browser/test"), true);
	for (const url of ["ws://evil:9223/devtools/browser/test", "wss://127.0.0.1:9223/devtools/browser/test", "ws://127.0.0.1:9222/devtools/browser/test", "ws://user:secret@127.0.0.1:9223/devtools/browser/test", "ws://127.0.0.1:9223/devtools/browser/test?token=secret", "ws://127.0.0.1:9223/devtools/page/test"]) assert.equal(validDebugEndpoint(url), false);
});

test("profile directory is private, symlink profile is rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "slack-profile-test-"));
	try {
		const dir = join(root, "profile");
		await prepareProfile(dir);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		await mkdir(join(root, "other"));
		await symlink(join(root, "other"), join(root, "linked"));
		await assert.rejects(prepareProfile(join(root, "linked")), { code: "wrong_profile" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("CDP cleanup closes only the owned tab and leaves holder browser alive", async () => {
	const root = await mkdtemp(join(tmpdir(), "slack-cdp-cleanup-"));
	// Isolated local test profile. No Slack URLs or real session state.
	const child = spawn(BRAVE, ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${root}`, "about:blank"], { stdio: "ignore" });
	let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
	try {
		let endpoint = "";
		for (let i = 0; i < 100; i++) {
			try {
				const [port, path] = (await readFile(join(root, "DevToolsActivePort"), "utf8")).trim().split("\n");
				endpoint = `ws://127.0.0.1:${port}${path}`; break;
			} catch { await new Promise(resolve => setTimeout(resolve, 100)); }
		}
		assert.ok(endpoint);
		browser = await chromium.connectOverCDP(endpoint);
		const holder = browser.contexts()[0].pages()[0];
		const holderURL = holder.url();
		const owned = await browser.contexts()[0].newPage();
		await closeAcquired(browser, owned, true); browser = undefined;
		assert.equal(child.exitCode, null);
		browser = await chromium.connectOverCDP(endpoint);
		assert.equal(browser.contexts()[0].pages().length, 1);
		assert.equal(browser.contexts()[0].pages()[0].url(), holderURL);
	} finally {
		await browser?.close();
		child.kill("SIGTERM");
		await new Promise(resolve => setTimeout(resolve, 500));
		await rm(root, { recursive: true, force: true });
	}
});

test("unregistered browser returns session_needed, without fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "slack-missing-test-"));
	try { await assert.rejects(acquireSession(new StateStore(join(root, "state")), join(root, "profile")), { code: "session_needed" }); }
	finally { await rm(root, { recursive: true, force: true }); }
});
