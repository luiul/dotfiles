import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ORIGIN, TEAM_ID, locationKind, parseArgs, readURL, type Args } from "../src/args.ts";
import type { Session } from "../src/session.ts";
import { ReaderError } from "../src/state.ts";
import { checkPage, extractChannels, extractMessages, readUI, redact, selectors, verifyLogin, type Result } from "../src/ui.ts";

// This is a local test browser, never the managed Slack browser or a real profile.
const executablePath = "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta";
const channel = "C11111111";
const thread = "1790812800.000002";
const historyArgs = () => parseArgs(["history", channel]);
const fixtureURL = (name: string) => new URL(`./fixtures/${name}.html`, import.meta.url);
const code = (expected: string) => (error: unknown) => {
	assert.ok(error instanceof ReaderError, "failure must use a safe ReaderError");
	assert.equal(error.code, expected);
	return true;
};

interface BrowserAudit { forbidden: string[]; interactions: string[]; }
interface RouteAudit { url: string; method: string; type: string; }
interface FixtureOptions {
	fixture?: string;
	replacements?: Record<string, string>;
	transform?: (html: string) => string;
	initialURL?: string;
	startAt?: string;
	redirectTo?: string;
	status?: number;
	guardLocation?: boolean;
	afterDOM?: () => void;
}

// The proxy makes non-DOM operations fail even if the result would otherwise pass.
function boundedPage(raw: Page, audit: string[], navigations: string[], options: FixtureOptions): Page {
	function boundedLocator(locator: Locator): Locator {
		return new Proxy(locator, {
			get(target, property) {
				if (property === "first") return () => boundedLocator(target.first());
				if (property === "isVisible" || property === "allTextContents") return target[property].bind(target);
				if (property === "evaluateAll") return async (...args: Parameters<Locator["evaluateAll"]>) => {
					const result = await target.evaluateAll(...args);
					options.afterDOM?.();
					return result;
				};
				audit.push(`locator.${String(property)}`);
				throw new Error("Reader used a forbidden locator operation");
			},
		});
	}
	return new Proxy(raw, {
		get(target, property) {
			if (property === "url") return () => options.initialURL ?? target.url();
			if (property === "locator") return (selector: string) => boundedLocator(target.locator(selector));
			if (property === "goto") return (url: string, settings: Parameters<Page["goto"]>[1]) => {
				navigations.push(url);
				assert.ok(navigations.length <= 1, "reader navigation must be bounded, with no retry");
				assert.equal(settings?.waitUntil, "domcontentloaded");
				assert.equal(settings?.timeout, 15_000);
				if (options.redirectTo) {
					const observed = new URL(options.redirectTo);
					assert.equal(observed.origin, ORIGIN);
					return target.goto(observed.href, settings);
				}
				return target.goto(url, settings);
			};
			audit.push(`page.${String(property)}`);
			throw new Error("Reader used a forbidden page operation");
		},
	});
}

function partial(result: Result, args: Args, reason: string, count: number): void {
	assert.deepEqual(Object.keys(result).sort(), ["command", "coverage", "data", "ok", "schema_version", "source", "team_id"]);
	assert.equal(result.schema_version, 1);
	assert.equal(result.ok, true);
	assert.equal(result.command, args.command);
	assert.equal(result.team_id, TEAM_ID);
	assert.equal(result.source, "headed_ui");
	assert.deepEqual(result.coverage, { complete: false, reason, returned: count, limit: args.limit, pagination: "none", order: "rendered" });
	if (result.data.messages) {
		assert.deepEqual(Object.keys(result.data).sort(), result.data.message ? ["message", "messages"] : ["messages"]);
		for (const row of result.data.messages) {
			assert.deepEqual(Object.keys(row).sort(), ["permalink", "text", "ts", "user"]);
			assert.equal(typeof row.text, "string");
			assert.ok(row.ts === null || /^\d{10}\.\d{6}$/.test(row.ts));
			assert.ok(row.user === null || typeof row.user === "string");
			assert.ok(row.permalink === null || typeof row.permalink === "string");
		}
	}
}

describe("rendered UI reader, local fixtures only", { concurrency: false }, () => {
	let context: BrowserContext;
	let profile: string;
	const fallbackRequests: string[] = [];

	before(async () => {
		profile = await mkdtemp(join(tmpdir(), "slack-ui-fixture-"));
		context = await chromium.launchPersistentContext(profile, {
			executablePath, headless: true, serviceWorkers: "block",
			args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
		});
		// Defense in depth: even a page without its fixture route cannot contact a server.
		await context.route("**/*", async route => {
			fallbackRequests.push(route.request().url());
			await route.abort("blockedbyclient");
		});
		await context.routeWebSocket("**/*", async socket => {
			fallbackRequests.push(socket.url());
			await socket.close();
		});
		await context.addInitScript(() => {
			const audit: BrowserAudit = { forbidden: [], interactions: [] };
			Object.defineProperty(window, "__readerAudit", { value: audit });
			const deny = (name: string) => () => {
				audit.forbidden.push(name);
				throw new Error("Forbidden operation in local reader test");
			};
			for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
				Object.defineProperty(window, name, { configurable: true, get: deny(name) });
			}
			Object.defineProperty(document, "cookie", { configurable: true, get: deny("cookie.get"), set: deny("cookie.set") });
			for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
				Object.defineProperty(window, name, { configurable: true, get: deny(name) });
			}
			Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: deny("sendBeacon") });
			Object.defineProperty(HTMLElement.prototype, "click", { configurable: true, value: deny("element.click") });
			Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: deny("scrollIntoView") });
			for (const name of ["scroll", "scrollTo", "scrollBy"]) {
				Object.defineProperty(window, name, { configurable: true, value: deny(name) });
			}
			for (const name of ["click", "input", "beforeinput", "keydown", "keypress", "keyup", "submit", "wheel"]) {
				document.addEventListener(name, () => audit.interactions.push(name), { capture: true });
			}
		});
	});

	after(async () => {
		try {
			if (context) await context.close();
			assert.equal(fallbackRequests.length, 0, "unexpected requests must never bypass the fixture route");
		} finally {
			if (profile) await rm(profile, { recursive: true, force: true });
		}
	});

	async function fixture(t: TestContext, options: FixtureOptions = {}) {
		let html = await readFile(fixtureURL(options.fixture ?? "history"), "utf8");
		for (const [key, value] of Object.entries(options.replacements ?? {})) html = html.replaceAll(`{{${key}}}`, value);
		if (options.transform) html = options.transform(html);
		const raw = await context.newPage();
		const routes: RouteAudit[] = [];
		const networkViolations: string[] = [];
		const forbidden: string[] = [];
		const navigations: string[] = [];
		let fault: ReaderError | undefined;
		let checks = 0;
		let closes = 0;
		raw.on("response", response => {
			if (new URL(response.url()).origin !== ORIGIN) return;
			if (response.status() === 429) fault = new ReaderError("rate_limited");
			if (response.status() === 401) fault = new ReaderError("auth_lost");
		});
		await raw.route("**/*", async route => {
			const request = route.request();
			const url = new URL(request.url());
			routes.push({ url: url.href, method: request.method(), type: request.resourceType() });
			// /api is never fulfilled, including accidental API calls on the trusted host.
			if (url.origin !== ORIGIN || /\/api(?:\/|$)/i.test(url.pathname)) {
				networkViolations.push("untrusted or API request");
				await route.abort("blockedbyclient");
				return;
			}
			await route.fulfill({ status: options.status ?? 200, contentType: "text/html; charset=utf-8", body: html,
				headers: { "Content-Security-Policy": "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'" } });
		});
		const page = boundedPage(raw, forbidden, navigations, options);
		const session: Session = {
			page,
			check() {
				checks++;
				if (fault) throw fault;
				if (options.guardLocation === false) return;
				const kind = locationKind(page.url());
				if (kind === "login") throw new ReaderError("auth_lost");
				if (kind !== "workspace") throw new ReaderError(kind);
			},
			async close() { closes++; },
		};
		t.after(async () => {
			try {
				const audit = await raw.evaluate(() => (window as unknown as { __readerAudit?: BrowserAudit }).__readerAudit);
				assert.deepEqual(forbidden, [], "reader may only use bounded goto and rendered DOM locators");
				assert.deepEqual(audit?.forbidden ?? [], [], "reader must not read storage, cookies, or browser APIs");
				assert.deepEqual(audit?.interactions ?? [], [], "reader must not click, fill, press, submit, or scroll");
				assert.deepEqual(networkViolations, [], "network attempts must not escape the fixture guard");
				assert.equal(closes, 0, "readUI does not own session cleanup");
				assert.ok(checks > 0, "reader must consult the session guard");
				assert.ok(navigations.length <= 1, "reader must not retry navigation");
				assert.equal(routes.length, navigations.length + (options.startAt ? 1 : 0), "only setup and bounded reader navigation are allowed");
				assert.ok(routes.every(r => new URL(r.url).origin === ORIGIN), "every request must use the intercepted origin");
				assert.ok(routes.every(r => !/\/api(?:\/|$)/i.test(new URL(r.url).pathname)), "reader must never request /api");
				assert.ok(routes.every(r => r.method === "GET" && r.type === "document"), "reader must not send API or write requests");
			} finally { await raw.close(); }
		});
		if (options.startAt) await raw.goto(options.startAt, { waitUntil: "domcontentloaded" });
		return { session, page, routes, navigations, checks: () => checks };
	}

	test("channels are partial, deduplicated, bounded, and restricted to exact workspace links", async t => {
		const h = await fixture(t, { fixture: "channels" });
		const args = parseArgs(["channels", "--limit", "2"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_joined_channels_only", 2);
		assert.deepEqual(result.data.channels, [{ id: channel, name: "#fixture-one" }, { id: "G22222222", name: "#fixture-two" }]);
		assert.deepEqual(h.navigations, [readURL(args)]);
	});

	test("channel names are redacted and untrusted or hidden links are excluded", async t => {
		const h = await fixture(t, { fixture: "channels" });
		const args = parseArgs(["channels"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_joined_channels_only", 3);
		assert.deepEqual(result.data.channels?.map(c => c.id), [channel, "G22222222", "C33333333"]);
		assert.ok(result.data.channels?.[2].name === "#fixture [REDACTED]");
		assert.ok(!JSON.stringify(result).includes("fixture-channel-secret"));
	});

	test("current div sidebar rows return only rendered channels with clean labels", async t => {
		const h = await fixture(t, { fixture: "channel-rows" });
		const args = parseArgs(["channels"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_joined_channels_only", 3);
		assert.deepEqual(result.data.channels, [
			{ id: channel, name: "fixture-one" }, { id: "G22222222", name: "fixture-two" },
			{ id: "C33333333", name: "fixture [REDACTED]" },
		]);
		assert.doesNotMatch(JSON.stringify(result), /unread|Fixture person|group DM|Unknown type|Outside sidebar|fixture-row-secret/);
	});

	test("current sidebar div rows respect the requested limit", async t => {
		const h = await fixture(t, { fixture: "channel-rows" });
		const args = parseArgs(["channels", "--limit", "1"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_joined_channels_only", 1);
		assert.deepEqual(result.data.channels, [{ id: channel, name: "fixture-one" }]);
	});

	for (const root of ["channel-sidebar", "channel_sidebar", "class-only"]) {
		test(`div channel rows work with ${root} sidebar root`, async t => {
			const h = await fixture(t, { fixture: "channel-rows", transform: html => html.replace('data-qa="channel-sidebar" class="p-channel_sidebar"', root === "class-only" ? 'class="p-channel_sidebar"' : `data-qa="${root}"`) });
			const result = await readUI(parseArgs(["channels", "--limit", "1"]), h.session);
			assert.equal(result.data.channels?.[0].id, channel);
		});
	}

	const rowDrift: Array<[string, (html: string) => string]> = [
		["missing channel ID", html => html.replace('data-qa-channel-sidebar-channel-id="C11111111"', "")],
		["invalid channel ID", html => html.replace('data-qa-channel-sidebar-channel-id="C11111111"', 'data-qa-channel-sidebar-channel-id="xoxc-fixture-secret"')],
		["inconsistent parent identity", html => html.replace('data-item-key="C11111111"', 'data-item-key="C99999999"')],
		["hidden name", html => html.replace('data-qa="channel_sidebar_name_fixture-one"', 'hidden data-qa="channel_sidebar_name_fixture-one"')],
		["missing name", html => html.replace('class="p-channel_sidebar__name">fixture-two', 'class="drifted-name">fixture-two')],
	];
	for (const [name, transform] of rowDrift) {
		test(`channel div rows fail closed on ${name}`, async t => {
			const h = await fixture(t, { fixture: "channel-rows", transform });
			await assert.rejects(readUI(parseArgs(["channels"]), h.session), code("ui_changed"));
		});
	}

	test("channel extraction ignores unknown row types instead of guessing IDs", async t => {
		const h = await fixture(t, { fixture: "channel-rows", startAt: readURL(parseArgs(["channels"])), transform: html => html.replaceAll('channel-type="channel"', 'channel-type="drifted"').replaceAll('channel-type="group"', 'channel-type="drifted"') });
		h.session.check();
		await assert.rejects(extractChannels(h.page), code("ui_changed"));
	});

	test("read follows only the supplied permalink and prioritizes its exact reply", async t => {
		const args = parseArgs(["read", `https://hellofresh.slack.com/archives/${channel}/p1790942400000003?thread_ts=${thread}&cid=${channel}`, "--limit", "2"]);
		const h = await fixture(t, { fixture: "replies", redirectTo: readURL(parseArgs(["replies", channel, thread])) });
		const result = await readUI(args, h.session);
		partial(result, args, "linked_message_only", 1);
		assert.equal(result.data.message?.ts, "1790942400.000003");
		assert.equal(result.data.messages?.[0].ts, result.data.message?.ts);
		assert.deepEqual(h.navigations, [readURL(args)]);
	});

	test("direct reads support current thread row markup and data-msg-ts", async t => {
		const args = parseArgs(["read", `https://hellofresh.slack.com/archives/${channel}/p1790942400000003?thread_ts=${thread}`, "--limit", "3"]);
		const h = await fixture(t, { fixture: "current-thread", redirectTo: readURL(parseArgs(["replies", channel, thread])) });
		const result = await readUI(args, h.session);
		partial(result, args, "linked_message_only", 1);
		assert.equal(result.data.message?.text, "Exact linked reply");
		assert.deepEqual(result.data.messages?.map(message => message.ts), ["1790942400.000003"]);
		assert.doesNotMatch(JSON.stringify(result.data), /Outside the thread/);
	});

	test("read fails closed when the linked message is not rendered", async t => {
		const args = parseArgs(["read", `https://hellofresh.slack.com/archives/${channel}/p1790999999000001?thread_ts=${thread}`]);
		const h = await fixture(t, { fixture: "replies", redirectTo: readURL(parseArgs(["replies", channel, thread])) });
		await assert.rejects(readUI(args, h.session), code("ui_changed"));
	});

	test("read without a thread returns the exact linked channel message", async t => {
		const args = parseArgs(["read", `https://hellofresh.slack.com/archives/${channel}/p1790942400000003`, "--limit", "1"]);
		const h = await fixture(t, { redirectTo: readURL(historyArgs()) });
		const result = await readUI(args, h.session);
		partial(result, args, "linked_message_only", 1);
		assert.equal(result.data.message?.ts, "1790942400.000003");
	});

	test("history returns only visible DOM rows in rendered order with nullable fields", async t => {
		const h = await fixture(t);
		const args = historyArgs();
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_messages_only", 6);
		assert.deepEqual(result.data.messages?.map(m => m.ts), ["1790812799.000001", thread, "1790942400.000003", "1790985600.000004", "1791072000.000005", "1791072001.000006"]);
		assert.ok(result.data.messages?.[0].text === "Fixture before range");
		assert.ok(result.data.messages?.[1].text === "Fixture lower bound");
		assert.equal(result.data.messages?.[4].user, null);
		assert.ok(result.data.messages?.[5].text === "");
		assert.equal(result.data.messages?.[0].permalink, "https://hellofresh.slack.com/archives/C11111111/p1790812799000001");
		assert.equal(result.data.messages?.[1].permalink, "https://app.slack.com/archives/C11111111/p1790812800000002");
		assert.equal(result.data.messages?.[3].permalink, null);
		assert.equal(result.data.messages?.[4].permalink, null);
		assert.equal(result.data.messages?.[5].permalink, null);
	});

	test("rendered message bodies, author names, and permalink queries do not leak credential patterns", async t => {
		const h = await fixture(t);
		const result = await readUI(historyArgs(), h.session);
		const output = JSON.stringify(result);
		assert.ok(!/xoxb-|fixture-(?:token|bearer|cookie|auth|secret|session|author-secret|link-secret)/i.test(output), "synthetic credentials must be redacted");
		assert.ok(result.data.messages?.[3].text.includes("[REDACTED]"));
		assert.ok(result.data.messages?.[3].user === "Fixture [REDACTED]");
	});

	for (const limit of [1, 2, 100]) {
		test(`history respects limit ${limit} after deduplication`, async t => {
			const h = await fixture(t);
			const args = parseArgs(["history", channel, "--limit", String(limit)]);
			const result = await readUI(args, h.session);
			partial(result, args, "rendered_messages_only", Math.min(limit, 6));
			assert.equal(result.data.messages?.[0].ts, "1790812799.000001");
		});
	}

	for (const [name, flags, expected] of [
		["inclusive after and exclusive before", ["--after", "2026-10-01", "--before", "2026-10-03"], [thread, "1790942400.000003"]],
		["after only", ["--after", "2026-10-03"], ["1790985600.000004", "1791072000.000005", "1791072001.000006"]],
		["before only", ["--before", "2026-10-01"], ["1790812799.000001"]],
		["empty range remains partial", ["--after", "2026-10-10"], []],
	] as const) {
		test(`history date filter: ${name}`, async t => {
			const h = await fixture(t);
			const args = parseArgs(["history", channel, ...flags]);
			const result = await readUI(args, h.session);
			partial(result, args, "rendered_messages_only", expected.length);
			assert.deepEqual(result.data.messages?.map(m => m.ts), expected);
		});
	}

	test("date filtering happens before the output limit", async t => {
		const h = await fixture(t);
		const args = parseArgs(["history", channel, "--limit", "1", "--after", "2026-10-01", "--before", "2026-10-03"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_messages_only", 1);
		assert.equal(result.data.messages?.[0].ts, thread);
	});

	test("history permits missing timestamps when no date filter is requested", async t => {
		const h = await fixture(t, { fixture: "missing-ts" });
		const args = historyArgs();
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_messages_only", 2);
		assert.equal(result.data.messages?.[1].ts, null);
		assert.equal(result.data.messages?.[1].user, null);
		assert.equal(result.data.messages?.[1].permalink, null);
	});

	for (const flag of ["--after", "--before"]) {
		test(`missing timestamp with ${flag} fails closed even beyond the result limit`, async t => {
			const h = await fixture(t, { fixture: "missing-ts" });
			const args = parseArgs(["history", channel, "--limit", "1", flag, "2026-10-01"]);
			await assert.rejects(readUI(args, h.session), code("ui_changed"));
		});
	}

	test("replies include the rendered parent and exclude messages outside the thread", async t => {
		const h = await fixture(t, { fixture: "replies" });
		const args = parseArgs(["replies", channel, thread]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_thread_messages_only", 3);
		assert.deepEqual(result.data.messages?.map(m => m.ts), [thread, "1790942400.000003", "1790985600.000004"]);
		assert.ok(result.data.messages?.[0].text === "Fixture thread parent");
		assert.deepEqual(h.navigations, [`${ORIGIN}/client/${TEAM_ID}/${channel}/thread/${channel}-${thread}`]);
	});

	test("reply output limit includes the parent", async t => {
		const h = await fixture(t, { fixture: "replies" });
		const args = parseArgs(["replies", channel, thread, "--limit", "1"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_thread_messages_only", 1);
		assert.equal(result.data.messages?.[0].ts, thread);
	});

	test("search uses encoded navigation, not a form, and preserves rendered result order", async t => {
		const h = await fixture(t, { fixture: "search" });
		const args = parseArgs(["search", "in:fixture-one alpha & beta + gamma"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_search_results_only", 3);
		assert.deepEqual(result.data.messages?.map(m => m.ts), ["1790985600.000004", thread, null]);
		assert.ok(result.data.messages?.[0].text === "Fixture first search result");
		assert.equal(result.data.messages?.[2].user, null);
		assert.equal(result.data.messages?.[2].permalink, null);
		assert.deepEqual(h.navigations, [`${ORIGIN}/client/${TEAM_ID}/search?q=in%3Afixture-one%20alpha%20%26%20beta%20%2B%20gamma`]);
	});

	test("search output is bounded after deduplication", async t => {
		const h = await fixture(t, { fixture: "search" });
		const args = parseArgs(["search", "fixture", "--limit", "2"]);
		const result = await readUI(args, h.session);
		partial(result, args, "rendered_search_results_only", 2);
		assert.deepEqual(result.data.messages?.map(m => m.ts), ["1790985600.000004", thread]);
	});

	for (const argv of [["history", channel], ["search", "fixture"]]) {
		test(`${argv[0]} accepts a visible empty state without claiming complete coverage`, async t => {
			const h = await fixture(t, { fixture: "empty" });
			const args = parseArgs(argv);
			const result = await readUI(args, h.session);
			partial(result, args, args.command === "search" ? "rendered_search_results_only" : "rendered_messages_only", 0);
			assert.deepEqual(result.data.messages, []);
		});
	}

	for (const argv of [["history", channel], ["replies", channel, thread], ["search", "fixture"], ["channels"]]) {
		test(`${argv[0]} fails closed on malformed rendered markup without a fallback`, async t => {
			const h = await fixture(t, { fixture: "drift" });
			await assert.rejects(readUI(parseArgs(argv), h.session), code("ui_changed"));
		});
	}

	test("history fails closed when the matching message text exists but is not rendered", async t => {
		const h = await fixture(t, { fixture: "hidden-text" });
		await assert.rejects(readUI(historyArgs(), h.session), code("ui_changed"));
	});

	test("already verified workspace avoids redundant navigation", async t => {
		const args = historyArgs();
		const h = await fixture(t, { startAt: readURL(args) });
		partial(await readUI(args, h.session), args, "rendered_messages_only", 6);
		assert.deepEqual(h.navigations, []);
	});

	test("doctor performs point-in-time DOM verification only", async t => {
		const h = await fixture(t, { fixture: "channels" });
		const result = await readUI(parseArgs(["doctor"]), h.session);
		assert.deepEqual(result.data, { session_verified: true });
		assert.deepEqual(result.coverage, { complete: true, reason: "point_in_time_ui_verification", returned: 1, limit: 1, pagination: "none", order: "rendered" });
	});

	for (const [attribute, text, expected] of [
		['role="alert"', "Too many requests", "rate_limited"],
		['data-qa="connection_status"', "Rate limit reached", "rate_limited"],
		['role="alert"', "Try again later", "rate_limited"],
		['data-qa="signin_form"', "Sign in", "auth_lost"],
		['role="alert"', "Session has expired", "auth_lost"],
		['data-qa="connection_status"', "Signed out", "auth_lost"],
		['role="alert"', "invalid_auth", "auth_lost"],
		['role="alert"', "token_revoked", "auth_lost"],
		['role="alert"', "not_authed", "auth_lost"],
		['role="alert"', "account_inactive", "auth_lost"],
		['data-qa="connection_status"', "Connection lost", "network_failure"],
		['role="alert"', "Unable to connect", "network_failure"],
		['role="alert"', "Offline", "network_failure"],
		['role="alert"', "Network error", "network_failure"],
	]) {
		test(`rendered status maps to ${expected} (${text}) without retry`, async t => {
			const h = await fixture(t, { fixture: "status", replacements: { STATUS_ATTRIBUTE: attribute, STATUS_TEXT: text } });
			await assert.rejects(readUI(historyArgs(), h.session), code(expected));
			assert.equal(h.navigations.length, 1);
		});
	}

	for (const [status, expected] of [[429, "rate_limited"], [401, "auth_lost"]] as const) {
		test(`session status ${status} fails closed without a second navigation`, async t => {
			const h = await fixture(t, { status });
			await assert.rejects(readUI(historyArgs(), h.session), code(expected));
			assert.equal(h.navigations.length, 1);
		});
	}

	for (const [name, url, expected] of [
		["wrong workspace", `${ORIGIN}/client/TOTHER/${channel}`, "wrong_workspace"],
		["login", `${ORIGIN}/signin`, "auth_lost"],
		["workspace login", "https://hellofresh.slack.com/", "auth_lost"],
		["Slack login", "https://slack.com/workspace-signin", "auth_lost"],
		["untrusted host", "https://example.invalid/client/T02AGMUUR", "untrusted_origin"],
		["lookalike host", "https://app.slack.com.example.invalid/client/T02AGMUUR", "untrusted_origin"],
		["insecure origin", "http://app.slack.com/client/T02AGMUUR", "untrusted_origin"],
		["credential URL", "https://fixture:fixture@app.slack.com/client/T02AGMUUR", "untrusted_origin"],
		["other port", "https://app.slack.com:9443/client/T02AGMUUR", "untrusted_origin"],
	]) {
		test(`rejects ${name} before navigating`, async t => {
			// Spoof only the mock page URL. Never navigate even a local browser to these hosts.
			const h = await fixture(t, { initialURL: url });
			await assert.rejects(readUI(historyArgs(), h.session), code(expected));
			assert.deepEqual(h.navigations, []);
			assert.deepEqual(h.routes, []);
		});
		test(`checkPage independently guards ${name}`, async t => {
			const h = await fixture(t, { initialURL: url, guardLocation: false });
			await assert.rejects(checkPage(h.session), code(expected));
			assert.deepEqual(h.routes, []);
		});
	}

	test("login verification does not navigate or enter credentials", async t => {
		const h = await fixture(t, { initialURL: `${ORIGIN}/signin`, guardLocation: false });
		await assert.rejects(verifyLogin(h.session), code("auth_lost"));
		assert.deepEqual(h.routes, []);
	});

	test("cancelled passive login verification returns promptly without browser activity", async t => {
		const h = await fixture(t, { initialURL: `${ORIGIN}/signin`, guardLocation: false });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(verifyLogin(h.session, true, controller.signal), code("cancelled"));
		// Cancellation is checked before even the session guard.
		assert.equal(h.checks(), 0);
		h.session.check();
		assert.deepEqual(h.routes, []);
	});

	test("navigation errors map to safe failures without retries", async t => {
		for (const [name, expected] of [["TimeoutError", "timeout"], ["Error", "network_failure"]]) {
			await t.test(expected, async child => {
				const args = historyArgs();
				const h = await fixture(child, { startAt: `${ORIGIN}/client/${TEAM_ID}` });
				let attempts = 0;
				const page = new Proxy(h.page, {
					get(target, property) {
						if (property !== "goto") return Reflect.get(target, property);
						return async () => {
							attempts++;
							const error = new Error("Fixture token=fixture-error-secret");
							error.name = name;
							throw error;
						};
					},
				});
				await assert.rejects(readUI(args, { ...h.session, page }), error => {
					code(expected)(error);
					assert.ok(!String(error).includes("fixture-error-secret"));
					return true;
				});
				assert.equal(attempts, 1);
				assert.deepEqual(h.navigations, []);
			});
		}
	});

	test("post-extraction auth loss prevents returning a successful result", async t => {
		let extracted = false;
		const h = await fixture(t, { afterDOM() { extracted = true; } });
		const guard = h.session.check.bind(h.session);
		t.mock.method(h.session, "check", () => {
			guard();
			if (extracted) throw new ReaderError("auth_lost");
		});
		await assert.rejects(readUI(historyArgs(), h.session), code("auth_lost"));
	});

	test("permalinks only retain trusted HTTPS archive paths without credentials or query data", async t => {
		const path = "/archives/C11111111/p1790812800000002";
		const links = [
			[`${ORIGIN}${path}?token=fixture-link-secret#fixture`, `${ORIGIN}${path}`],
			[`https://hellofresh.slack.com${path}?fixture=1`, `https://hellofresh.slack.com${path}`],
			[`http://app.slack.com${path}`, null],
			[`https://example.invalid${path}`, null],
			[`https://app.slack.com.example.invalid${path}`, null],
			[`https://fixture:fixture@app.slack.com${path}`, null],
			[`https://app.slack.com:9443${path}`, null],
			[`${ORIGIN}${path}/extra`, null],
			[`${ORIGIN}/api/conversations.history`, null],
			[`${ORIGIN}/archives/C11111111/p123`, null],
		] as const;
		const rows = links.map(([href], i) => `<article data-qa="message_container" data-ts="1790812800.${String(i).padStart(6, "0")}"><div data-qa="message-text">Fixture link</div><a href="${href}">Timestamp</a></article>`).join("\n");
		const h = await fixture(t, { fixture: "links", replacements: { ROWS: rows } });
		const result = await readUI(historyArgs(), h.session);
		assert.deepEqual(result.data.messages?.map(m => m.permalink), links.map(([, expected]) => expected));
	});

	test("message extraction is capped at 500 rendered rows and output at the requested limit", async t => {
		const rows = Array.from({ length: 510 }, (_, i) => `<article data-qa="message_container" data-ts="1790812800.${String(i).padStart(6, "0")}"><div data-qa="message-text">Fixture bounded row</div></article>`).join("\n");
		const args = parseArgs(["history", channel, "--limit", "100"]);
		const h = await fixture(t, { fixture: "links", replacements: { ROWS: rows }, startAt: readURL(args) });
		const messages = await extractMessages(h.page, selectors.messages);
		assert.equal(messages.length, 500);
		assert.equal(messages.at(-1)?.ts, "1790812800.000499");
		partial(await readUI(args, h.session), args, "rendered_messages_only", 100);
		assert.deepEqual(h.navigations, []);
	});
});

for (const argv of [["channels"], ["history", channel], ["replies", channel, thread], ["search", "fixture"]]) {
	test(`${argv[0]} missing selectors fail closed using a virtual clock, not a 12 second wait`, async t => {
		const args = parseArgs(argv);
		let url = "about:blank";
		let navigations = 0;
		let observations = 0;
		const locator = {
			first() { return this; },
			async isVisible() { observations++; return false; },
			async allTextContents() { return []; },
			async evaluateAll() { assert.fail("missing selectors must not trigger extraction or an API fallback"); },
		};
		const page = {
			url() { return url; },
			async goto(target: string) { url = target; navigations++; },
			locator() { return locator; },
		} as unknown as Page;
		const session: Session = {
			page,
			check() { assert.equal(locationKind(page.url()), "workspace"); },
			async close() { assert.fail("reader must not own session cleanup"); },
		};
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
		const pending = assert.rejects(readUI(args, session), code("ui_changed"));
		for (let i = 0; i < 55; i++) {
			for (let j = 0; j < 12; j++) await Promise.resolve();
			t.mock.timers.tick(250);
		}
		await pending;
		assert.equal(navigations, 1);
		assert.ok(observations > 0 && observations <= 100, "selector polling must be bounded");
	});
}

test("passive verification times out without navigation when readiness selectors drift", async t => {
	let visibleChecks = 0;
	const page = {
		url() { return `${ORIGIN}/client/${TEAM_ID}`; },
		locator(selector: string) {
			return {
				first() { return this; },
				async allTextContents() { return []; },
				async isVisible() { assert.equal(selector, selectors.ready); visibleChecks++; return false; },
			};
		},
	} as unknown as Page;
	const session: Session = { page, check() {}, async close() { assert.fail("verification does not own cleanup"); } };
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	const pending = assert.rejects(verifyLogin(session), code("timeout"));
	for (let i = 0; i < 30; i++) {
		for (let j = 0; j < 8; j++) await Promise.resolve();
		t.mock.timers.tick(500);
	}
	await pending;
	assert.ok(visibleChecks > 0 && visibleChecks <= 24);
});

test("credential redaction handles synthetic Slack tokens, bearer values, and secret assignments", () => {
	const source = "Fixture XOXB-fixture-token xoxc-fixture-cookie Bearer fixture-bearer token=fixture-token; authorization:fixture-auth; password=fixture-password; cookie=fixture-cookie; secret=fixture-secret; d-s=fixture-session; d=fixture-d";
	const output = redact(source);
	assert.ok(!/xox[bcp]-|fixture-(?:token|cookie|bearer|auth|password|secret|session|d)/i.test(output));
	assert.ok(output.startsWith("Fixture [REDACTED] [REDACTED] Bearer [REDACTED]"));
	assert.ok(redact("Fixture ordinary prose") === "Fixture ordinary prose");
});
