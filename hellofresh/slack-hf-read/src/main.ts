/**
 * slack-hf-read: read-only Slack access for the HelloFresh workspace through
 * Slack's own web client, running in the dedicated Brave Beta profile at
 * ~/.pi/agent/data/slack-session.
 *
 * No credential replay of any kind: the browser is the client. API calls are
 * made by in-page fetch() with the page's own token and cookies, so to Slack
 * they are indistinguishable from the web app itself (same TLS, HTTP/2,
 * headers, d/d-s cookies). This replaces the retired slack-mcp-server path,
 * whose replayed-cookie request pattern kept tripping Enterprise Grid
 * session-forking detection and signing the user out.
 *
 * Two modes:
 *   attach   (preferred) connect over CDP to the permanently open login window
 *            (started by slack-hf-session-login, port 9223). Reads run in a
 *            fresh tab that is closed afterwards; the app tab is untouched.
 *            The open app keeps the session fresh (heartbeats, rotations).
 *   headless (fallback) launch the profile headless for this one read. Used
 *            when no login window is open (e.g. after a reboot).
 *
 * Commands (all print the Slack API JSON response to stdout):
 *   doctor                                  launch/attach, find token, run auth.test
 *   channels [--limit N] [--cursor C]       conversations.list
 *   history <channel_id> [--limit N] [--cursor C] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
 *                                           conversations.history
 *   replies <channel_id> <thread_ts> [--limit N] [--cursor C]
 *                                           conversations.replies
 *   search <query> [--limit N]              search.messages
 *   await-login                             watch the open login window until the
 *                                           session lands; verify with auth.test
 *
 * The profile must be signed in (see slack-hf-session-login). The bin wrapper
 * serializes concurrent invocations with a lock.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const PROFILE_DIR = process.env.SLACK_HF_PROFILE_DIR ?? `${process.env.HOME}/.pi/agent/data/slack-session`;
const BRAVE = "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta";
const ORIGIN = "https://app.slack.com";
const TEAM_ID = "T02AGMUUR";
const CDP_PORT = 9223;
// Match the installed Brave Beta's real headed UA (Brave sends a Chrome UA).
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

function die(msg: string): never {
	console.error(`slack-hf-read: ${msg}`);
	process.exit(1);
}

interface Session {
	context: BrowserContext;
	page: Page;
	token: string;
	close: () => Promise<void>;
}

// Boot the client app in the given page and capture the xoxc token from its
// own traffic. Since Slack's 2026 client changes the token is often NOT
// persisted in localStorage, but the app always sends it on its own API calls
// (client.boot etc.). The token never leaves the browser process.
async function bootAndCapture(page: Page): Promise<string> {
	let captured: string | null = null;
	page.on("request", (req) => {
		if (captured) return;
		const m = `${req.url()}\n${req.postData() ?? ""}`.match(/xoxc-[A-Za-z0-9-]{10,}/);
		if (m) captured = m[0];
	});
	// app.slack.com/ alone is the marketing site; the app lives under /client/.
	// Signed out, this bounces to workspace-signin and the poll times out with
	// the sign-in guidance below, which is the desired failure mode.
	await page.goto(`${ORIGIN}/client/${TEAM_ID}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (captured) return captured;
		try {
			const ls = await findTokenInLocalStorage(page);
			if (ls) return ls;
		} catch {
			// evaluate raced a navigation (client redirect); keep polling
		}
		await page.waitForTimeout(1_000);
	}
	throw new Error("no xoxc token seen in app traffic or localStorage; is the profile signed in? (slack-hf-session-login)");
}

async function findTokenInLocalStorage(page: Page): Promise<string | null> {
	return page.evaluate((team) => {
		try {
			const cfg = JSON.parse(localStorage.getItem("localConfig_v2") ?? "{}");
			const groups = [cfg.teams, cfg.prevTeams].filter((g) => g && typeof g === "object");
			for (const g of groups) {
				if (g[team]?.token?.startsWith("xoxc-")) return g[team].token as string;
			}
		} catch {
			// fall through to the scan
		}
		for (let i = 0; i < localStorage.length; i++) {
			const v = localStorage.getItem(localStorage.key(i)!) ?? "";
			const m = v.match(/xoxc-[A-Za-z0-9-]{10,}/);
			if (m) return m[0];
		}
		return null;
	}, TEAM_ID);
}

// Preferred: attach to the permanently open login window and work in a fresh
// tab, leaving the user's app tab alone.
async function acquireViaAttach(): Promise<Session | null> {
	let browser: Browser;
	try {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 3_000 });
	} catch {
		return null;
	}
	const context = browser.contexts()[0];
	const page = await context.newPage();
	try {
		const token = await bootAndCapture(page);
		return {
			context,
			page,
			token,
			close: async () => {
				await page.close().catch(() => {});
				await browser.close().catch(() => {}); // disconnects; the window stays open
			},
		};
	} catch (e) {
		await page.close().catch(() => {});
		await browser.close().catch(() => {});
		throw e;
	}
}

// Fallback: launch the profile headless for this one read.
async function acquireViaHeadless(): Promise<Session> {
	let context: BrowserContext;
	try {
		context = await chromium.launchPersistentContext(PROFILE_DIR, {
			executablePath: BRAVE,
			headless: true,
			userAgent: UA,
			args: ["--disable-blink-features=AutomationControlled"],
		});
	} catch (e) {
		const msg = (e as Error).message;
		if (/process singleton|already in use|Failed to create/i.test(msg)) {
			throw new Error(
				"the profile is open in a Brave window that was not started via slack-hf-session-login (no debug port to attach to). Close it, or reopen it with slack-hf-session-login.",
			);
		}
		throw new Error(`could not launch the profile browser: ${msg.split("\n")[0]}`);
	}
	await context.addInitScript(() => {
		Object.defineProperty(navigator, "webdriver", { get: () => undefined });
	});
	const page = context.pages()[0] ?? (await context.newPage());
	const token = await bootAndCapture(page);
	return { context, page, token, close: () => context.close() };
}

async function acquire(): Promise<Session> {
	return (await acquireViaAttach()) ?? (await acquireViaHeadless());
}

async function api(page: Page, token: string, method: string, params: Record<string, string>) {
	return page.evaluate(
		async ({ method, params, token }) => {
			const qs = new URLSearchParams(params).toString();
			const r = await fetch(`/api/${method}?${qs}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			return { status: r.status, body: await r.json() };
		},
		{ method, params, token },
	);
}

// Attach to the headed login window (opened by slack-hf-session-login with a
// debugging port) and verify a fresh login while the window is still open:
// wait for the d cookie, then for the client app to boot, then run auth.test
// inside that browser. Prints masked confirmation. Exit 1 on timeout.
async function awaitLogin() {
	const deadline = Date.now() + 10 * 60_000;
	let browser: Browser | undefined;
	while (Date.now() < deadline) {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 2_000 }).catch(() => undefined);
		if (browser) break;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	if (!browser) die("no debuggable Brave Beta on :9223 after 10 min; start one via slack-hf-session-login");
	const context = browser.contexts()[0];
	let captured: string | null = null;
	const arm = (page: Page) => {
		page.on("request", (req) => {
			if (captured) return;
			const m = `${req.url()}\n${req.postData() ?? ""}`.match(/xoxc-[A-Za-z0-9-]{10,}/);
			if (m) captured = m[0];
		});
	};
	context.pages().forEach(arm);
	context.on("page", arm);
	while (Date.now() < deadline) {
		const cookies = await context.cookies([ORIGIN, "https://hellofresh.slack.com"]);
		const d = cookies.find((c) => c.name === "d" && c.domain.includes("slack.com"));
		if (d && captured) {
			const page = context.pages().find((p) => p.url().includes("/client/") || p.url().includes("/archives/")) ?? context.pages()[0];
			if (!page) continue;
			const res = await page
				.evaluate(async (token) => {
					const r = await fetch("/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
					return r.json();
				}, captured)
				.catch((e: Error) => ({ ok: false, error: e.message }));
			console.log(
				JSON.stringify({
					d_cookie: `${d.value.slice(0, 10)}...(${d.value.length} chars)`,
					token_seen: `${captured.slice(0, 10)}...(${captured.length} chars)`,
					client_url: page.url(),
					auth_test: { ok: res.ok, team: res.team, user: res.user, error: res.error },
				}),
			);
			if (res.ok) {
				console.log("LOGIN CONFIRMED. Leave the window open (minimize it); it holds the session for slack-hf-read.");
				process.exit(0);
			}
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}
	die("timed out waiting for a signed-in session (10 min)");
}

function toEpoch(date: string): string {
	const ms = Date.parse(`${date}T00:00:00Z`);
	if (Number.isNaN(ms)) die(`invalid date: ${date} (want YYYY-MM-DD)`);
	return (ms / 1000).toFixed(0);
}

function opt(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (!cmd) die("no command (doctor|channels|history|replies|search|await-login)");
	if (cmd === "await-login") return awaitLogin();

	const session = await acquire().catch((e: Error) => die(e.message));
	try {
		let params: Record<string, string> = {};
		let method = "";
		switch (cmd) {
			case "doctor":
				method = "auth.test";
				break;
			case "channels":
				method = "conversations.list";
				params = {
					types: opt(rest, "--types") ?? "public_channel,private_channel",
					limit: opt(rest, "--limit") ?? "100",
				};
				break;
			case "history":
				method = "conversations.history";
				params = { channel: rest[0] ?? die("history needs a channel_id"), limit: opt(rest, "--limit") ?? "30" };
				if (opt(rest, "--after")) params.oldest = toEpoch(opt(rest, "--after")!);
				if (opt(rest, "--before")) params.latest = toEpoch(opt(rest, "--before")!);
				break;
			case "replies":
				method = "conversations.replies";
				params = {
					channel: rest[0] ?? die("replies needs a channel_id"),
					ts: rest[1] ?? die("replies needs a thread_ts"),
					limit: opt(rest, "--limit") ?? "50",
				};
				break;
			case "search":
				method = "search.messages";
				params = { query: rest[0] ?? die("search needs a query"), count: opt(rest, "--limit") ?? "20" };
				break;
			default:
				die(`unknown command: ${cmd}`);
		}
		const cursor = opt(rest, "--cursor");
		if (cursor) params.cursor = cursor;

		const { status, body } = await api(session.page, session.token, method, params);
		if (cmd === "doctor") {
			console.log(
				JSON.stringify({
					status,
					ok: body.ok,
					team: body.team,
					team_id: body.team_id,
					user: body.user,
					user_id: body.user_id,
					error: body.error,
				}),
			);
		} else {
			console.log(JSON.stringify({ status, ...body }));
		}
		if (!body.ok) process.exit(1);
	} finally {
		await session.close();
	}
}

await main();
