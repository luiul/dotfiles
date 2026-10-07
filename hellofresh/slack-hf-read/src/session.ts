import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { ORIGIN, locationKind } from "./args.ts";
import { ReaderError, StateStore, processStarted } from "./state.ts";

export async function closeAcquired(browser: Browser, page?: Page, owned = false): Promise<void> {
	try { if (page && owned && !page.isClosed()) await page.close(); }
	finally { await browser.close(); }
}

export const BRAVE = "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta";
export const CDP_PORT = 9223;
const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

export interface Session {
	page: Page;
	observingLogin?: boolean;
	check(): void;
	close(failed: boolean): Promise<void>;
}

export function validBrowserCommand(command: string, profile: string): boolean {
	const all = (flag: string) => [...command.matchAll(new RegExp(`(?:^| )${flag}=([^ ]+)`, "g"))].map(match => match[1]);
	return command.startsWith(`${BRAVE} `) && all("--user-data-dir").length === 1 && all("--user-data-dir")[0] === profile
		&& all("--remote-debugging-port").length === 1 && all("--remote-debugging-port")[0] === "9223"
		&& all("--remote-debugging-address").length === 1 && all("--remote-debugging-address")[0] === "127.0.0.1"
		&& !/--headless|--user-agent|AutomationControlled|--remote-debugging-pipe/.test(command);
}

export function validDebugEndpoint(value: string): boolean {
	try {
		const ws = new URL(value);
		return ws.protocol === "ws:" && ws.hostname === "127.0.0.1" && ws.port === "9223"
			&& !ws.username && !ws.password && !ws.search && !ws.hash && ws.pathname.startsWith("/devtools/browser/");
	} catch { return false; }
}

export function browserOwned(browser: { pid: number; started: string; profile: string }, profile: string): boolean {
	if (browser.profile !== profile || processStarted(browser.pid) !== browser.started) return false;
	try {
		const command = execFileSync("ps", ["-p", String(browser.pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).trim();
		return validBrowserCommand(command, profile);
	} catch { return false; }
}

export function validLocalListener(output: string): boolean {
	const lines = output.trim().split("\n").slice(1);
	return lines.length > 0 && lines.every(line => /TCP 127\.0\.0\.1:9223 \(LISTEN\)$/.test(line));
}

export function listenerLocal(pid: number): boolean {
	try {
		return validLocalListener(execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP:9223", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 2_000 }));
	} catch { return false; }
}

export async function prepareProfile(profile: string): Promise<void> {
	await mkdir(profile, { recursive: true, mode: 0o700 });
	const stat = await lstat(profile);
	if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) throw new ReaderError("wrong_profile");
	await chmod(profile, 0o700);
}

export async function startLogin(store: StateStore, profile: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new ReaderError("cancelled");
	await prepareProfile(profile);
	const state = await store.read();
	if (state.browser && browserOwned(state.browser, profile)) {
		if (!listenerLocal(state.browser.pid)) throw new ReaderError("wrong_browser");
		// Never drive SSO or reload an existing holder. The user signs in there.
		return;
	}
	if (state.browser && processStarted(state.browser.pid) === state.browser.started) throw new ReaderError("wrong_browser");
	// A profile already opened outside this helper must not be silently adopted.
	try { await lstat(`${profile}/SingletonLock`); throw new ReaderError("wrong_profile"); }
	catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
	const child = spawn(BRAVE, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", "https://hellofresh.slack.com/"], { detached: true, stdio: "ignore" });
	let failed = false;
	child.once("error", () => { failed = true; });
	child.unref();
	await new Promise(resolve => setTimeout(resolve, 150));
	if (failed || !child.pid) throw new ReaderError("session_needed");
	const started = processStarted(child.pid);
	if (!started) throw new ReaderError("session_needed");
	state.browser = { pid: child.pid, started, profile };
	try {
		await store.write(state);
		// Poll local process readiness only. This does not send Slack requests.
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline && !listenerLocal(child.pid)) {
			if (signal?.aborted) throw new ReaderError("cancelled");
			if (processStarted(child.pid) !== started) throw new ReaderError("session_needed");
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const browser = await connect(store, profile);
		try {
			const pages = browser.contexts()[0]?.pages() ?? [];
			const holder = pages.find(page => ["workspace", "login"].includes(locationKind(page.url()))) ?? (pages.length === 1 ? pages[0] : undefined);
			if (!holder) throw new ReaderError("session_needed");
			state.browser.holder_id = await targetID(holder);
			await store.write(state);
			if (signal?.aborted) throw new ReaderError("cancelled");
		} finally { await browser.close(); }
	} catch (error) {
		// Only terminate the exact newly started browser, never an existing holder.
		if (processStarted(child.pid) === started && browserOwned(state.browser, profile)) child.kill("SIGTERM");
		delete state.browser;
		await store.write(state);
		throw error;
	}
}

async function connect(store: StateStore, profile: string): Promise<Browser> {
	await prepareProfile(profile);
	const state = await store.read();
	if (!state.browser || processStarted(state.browser.pid) !== state.browser.started) throw new ReaderError("session_needed");
	if (state.browser.profile !== profile) throw new ReaderError("wrong_profile");
	if (!browserOwned(state.browser, profile) || !listenerLocal(state.browser.pid)) throw new ReaderError("wrong_browser");
	try {
		// This fetch is localhost only. It does not contact Slack.
		const response = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(3_000), redirect: "error" });
		const data = await response.json() as { webSocketDebuggerUrl?: string };
		if (!response.ok || !validDebugEndpoint(data.webSocketDebuggerUrl ?? "")) throw new ReaderError("wrong_browser");
		return await chromium.connectOverCDP(data.webSocketDebuggerUrl!, { timeout: 3_000 });
	} catch (error) {
		if (error instanceof ReaderError) throw error;
		throw new ReaderError("session_needed");
	}
}

async function targetID(page: Page): Promise<string> {
	const cdp = await page.context().newCDPSession(page);
	try { return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId; }
	finally { await cdp.detach(); }
}

export interface SessionDependencies {
	connect: typeof connect;
	targetID: typeof targetID;
}

export async function acquireSession(store: StateStore, profile: string, login = false, deps: SessionDependencies = { connect, targetID }): Promise<Session> {
	const browser = await deps.connect(store, profile);
	let page: Page | undefined;
	let owned = false;
	const listeners: Array<() => void> = [];
	try {
		const context = browser.contexts()[0];
		if (!context || browser.contexts().length !== 1) throw new ReaderError("wrong_browser");
		const state = await store.read();
		const pages = context.pages();
		if (login) {
			// Observe only the recorded holder, including user-controlled SSO redirects.
			if (state.browser?.holder_id) {
				for (const candidate of pages) if (await deps.targetID(candidate) === state.browser.holder_id && state.browser.holder_id !== state.browser.target_id) { page = candidate; break; }
				if (!page) throw new ReaderError("session_needed");
			} else {
				for (const candidate of pages) {
					if (await deps.targetID(candidate) !== state.browser?.target_id && ["workspace", "login"].includes(locationKind(candidate.url()))) { page = candidate; break; }
				}
			}
			if (!page) throw new ReaderError("session_needed");
			if (!state.browser) throw new ReaderError("state_invalid");
			state.browser.holder_id = await deps.targetID(page);
			await store.write(state);
		} else {
			if (state.browser?.target_id) {
				if (state.browser.target_id === state.browser.holder_id) throw new ReaderError("state_invalid");
				for (const candidate of pages) if (await deps.targetID(candidate) === state.browser.target_id) { page = candidate; owned = true; break; }
			}
			if (page && locationKind(page.url()) !== "workspace") {
				const kind = locationKind(page.url());
				throw new ReaderError(kind === "login" || kind === "untrusted_origin" ? "auth_lost" : kind);
			}
			let holder: Page | undefined;
			for (const candidate of pages) {
				if (state.browser?.holder_id && await deps.targetID(candidate) === state.browser.holder_id) { holder = candidate; break; }
			}
			if (!holder) throw new ReaderError("session_needed");
			const holderKind = locationKind(holder.url());
			if (holderKind !== "workspace") throw new ReaderError(holderKind === "wrong_workspace" ? holderKind : "auth_lost");
			if (!page) {
				page = await context.newPage(); owned = true;
				if (!state.browser) throw new ReaderError("state_invalid");
				state.browser.target_id = await deps.targetID(page);
				await store.write(state);
			}
		}
		let fault: ReaderError | undefined;
		const selected = page;
		selected.setDefaultTimeout(5_000);
		const onResponse = (response: { url(): string; status(): number }) => {
			try {
				const url = new URL(response.url());
				if (url.origin !== ORIGIN) return;
				if (response.status() === 429 && fault?.code !== "auth_lost") fault = new ReaderError("rate_limited");
				if (response.status() === 401) fault = new ReaderError("auth_lost");
			} catch { /* No response bodies or credentials enter Node. */ }
		};
		selected.on("response", onResponse);
		const onNavigation = (frame: { parentFrame(): unknown }) => {
			if (frame.parentFrame() || login) return;
			const kind = locationKind(selected.url());
			// Reads never leave Slack. Any external redirect stops and pauses them.
			if (kind === "login" || kind === "untrusted_origin") fault = new ReaderError("auth_lost");
		};
		selected.on("framenavigated", onNavigation);
		listeners.push(() => selected.off("response", onResponse), () => selected.off("framenavigated", onNavigation));
		return {
			page: selected,
			observingLogin: login,
			check() {
				if (fault) throw fault;
				const kind = locationKind(selected.url());
				if (login) { if (kind === "wrong_workspace") throw new ReaderError(kind); return; }
				if (kind === "login") throw new ReaderError("auth_lost");
				if (kind !== "workspace") throw new ReaderError(kind);
			},
			async close(failed) {
				try {
					for (const remove of listeners) remove();
					if (failed && owned && !selected.isClosed()) {
						await selected.close();
						const latest = await store.read();
						if (latest.browser) delete latest.browser.target_id;
						await store.write(latest);
					}
				} finally { await browser.close(); } // Playwright CDP disconnect, not Browser.close CDP.
			},
		};
	} catch (error) {
		// Keep the original auth symptom even if owned-resource cleanup fails.
		try { await closeAcquired(browser, page, owned); } catch { /* Caller still sees the safe original failure. */ }
		throw error;
	}
}
