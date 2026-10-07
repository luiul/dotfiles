import type { Page } from "playwright-core";
import { ORIGIN, TEAM_ID, locationKind, readURL, type Args } from "./args.ts";
import { ReaderError } from "./state.ts";
import type { Session } from "./session.ts";

// These are rendered UI selectors, not Slack client state or API endpoints.
const sidebarRoots = ['[data-qa="channel_sidebar"]', '[data-qa="channel-sidebar"]', '.p-channel_sidebar'];
export const selectors = {
	ready: '[data-qa="team_menu"], [data-qa="channel_sidebar"], [data-qa="channel-sidebar"], .p-channel_sidebar, [data-qa="message_input"], .p-workspace__sidebar',
	channelItems: sidebarRoots.map(root => `${root} a[href], ${root} [data-qa="channel-sidebar-channel"]`).join(", "),
	messages: '[data-qa="message_container"], .c-message_kit__message',
	thread: '[data-qa="thread_view"], .p-thread_view',
	search: '[data-qa="search_results"], .p-search_results',
	searchMessages: '[data-qa="search_result"], .c-search_message',
	noResults: '[data-qa="search_no_results"], .p-search_results__no_results',
	emptyHistory: '[data-qa="channel_empty_state"], .p-channel_empty_state',
};

export interface Message {
	ts: string | null;
	user: string | null;
	text: string;
	permalink: string | null;
}
export interface Channel { id: string; name: string; }
export interface Result {
	schema_version: 1;
	ok: true;
	command: string;
	team_id: string;
	source: "headed_ui";
	data: { channels?: Channel[]; messages?: Message[]; message?: Message; session_verified?: boolean };
	coverage: { complete: boolean; reason: string; returned: number; limit: number; pagination: "none"; order: "rendered" };
}

// Also redact accidental credentials in rendered messages and error output.
export function redact(value: string): string {
	return value.replace(/xox[a-z]-[A-Za-z0-9%._-]+/gi, "[REDACTED]")
		.replace(/\b(?:Bearer\s+)[A-Za-z0-9%._-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:cookie|token|authorization|secret|password|d-s|d)\s*[:=]\s*["']?[^\s"'<>,;]+/gi, "[REDACTED]");
}

export async function checkPage(session: Session): Promise<void> {
	session.check();
	const page = session.page;
	const kind = locationKind(page.url());
	if (kind === "login") throw new ReaderError("auth_lost");
	if (kind !== "workspace") throw new ReaderError(kind);
	// Inspect only rendered status text, never response bodies or storage.
	const status = await page.locator('[role="alert"], [data-qa="signin_form"], [data-qa="connection_status"]').allTextContents();
	if (status.some(s => /sign in|session (?:has )?expired|signed out|invalid_auth|token_revoked|not_authed|account_inactive/i.test(s))) throw new ReaderError("auth_lost");
	if (status.some(s => /too many requests|rate limit|try again later/i.test(s))) throw new ReaderError("rate_limited");
	if (status.some(s => /connection lost|unable to connect|offline|network error/i.test(s))) throw new ReaderError("network_failure");
}

async function waitRendered(session: Session, selector: string, emptySelector?: string, timeout = 12_000, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new ReaderError("cancelled");
		await checkPage(session);
		if (await session.page.locator(selector).first().isVisible()) return;
		if (emptySelector && await session.page.locator(emptySelector).first().isVisible()) return;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new ReaderError("ui_changed");
}

export async function verifyLogin(session: Session, wait = false, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + (wait ? 10 * 60_000 : 12_000);
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new ReaderError("cancelled");
		session.check();
		const kind = locationKind(session.page.url());
		if (kind === "workspace") {
			await checkPage(session);
			if (await session.page.locator(selectors.ready).first().isVisible()) return;
		} else if (kind === "wrong_workspace") throw new ReaderError(kind);
		else if (kind !== "login" && !session.observingLogin) throw new ReaderError(kind);
		else if (!wait) throw new ReaderError("auth_lost");
		// Passive DOM observation. No requests, reloads, cookies, or credential tests.
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new ReaderError("timeout");
}

export async function extractMessages(page: Page, selector: string): Promise<Message[]> {
	const rows = await page.locator(selector).evaluateAll(elements => {
		const rendered = (node: Element) => {
			const el = node as HTMLElement;
			return !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
		};
		return elements.filter(rendered).slice(0, 500).map(element => {
			const row = element.closest('[data-msg-ts], [data-ts], [data-item-key], [data-message-id]') ?? element;
			const links = [...element.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(rendered);
			const link = links.find(a => /\/archives\/[CG][A-Z0-9]+\/p\d{16}/.test(a.href));
			const match = link?.href.match(/\/p(\d{10})(\d{6})/);
			const attr = row.getAttribute("data-msg-ts") ?? row.getAttribute("data-ts") ?? row.getAttribute("data-message-id") ?? row.getAttribute("data-item-key");
			const ts = attr?.match(/\d{10}\.\d{6}/)?.[0] ?? (match ? `${match[1]}.${match[2]}` : null);
			const text = element.querySelector<HTMLElement>('[data-qa="message-text"], [data-qa="message_text"], .c-message_kit__text, .c-search_message__body');
			const author = element.querySelector<HTMLElement>('[data-qa="message_sender_name"], .c-message__sender, .c-message_kit__sender');
			return { ts, user: author && rendered(author) ? author.innerText.trim() : null, text: text && rendered(text) ? text.innerText.trim() : null, permalink: link?.href ?? null };
		});
	});
	if (rows.some(row => row.text === null)) throw new ReaderError("ui_changed");
	const seen = new Set<string>();
	return rows.filter(row => {
		const key = row.ts ?? JSON.stringify(row);
		if (seen.has(key)) return false;
		seen.add(key); return true;
	}).map(row => ({ ...row, text: redact(row.text!), user: row.user ? redact(row.user) : null, permalink: safePermalink(row.permalink) }));
}

function safePermalink(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || !["app.slack.com", "hellofresh.slack.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
		if (!/^\/archives\/[CG][A-Z0-9]+\/p\d{16}$/.test(url.pathname)) return null;
		return `${url.origin}${url.pathname}`;
	} catch { return null; }
}

export async function extractChannels(page: Page): Promise<Channel[]> {
	const items = await page.locator(selectors.channelItems).evaluateAll(elements => {
		const rendered = (element: Element) => !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
		return elements.filter(rendered).slice(0, 500).map(element => {
			if (element.tagName === "A") return { kind: "link", href: (element as HTMLAnchorElement).href, name: (element as HTMLElement).innerText.trim() };
			const name = element.querySelector<HTMLElement>('.p-channel_sidebar__name, [data-qa^="channel_sidebar_name_"]');
			const id = element.getAttribute("data-qa-channel-sidebar-channel-id");
			const parentID = element.closest('[role="treeitem"][data-item-key]')?.getAttribute("data-item-key");
			return { kind: "row", id, type: element.getAttribute("data-qa-channel-sidebar-channel-type"),
				name: name && rendered(name) ? name.innerText.trim() : "", identityMatches: !parentID || parentID === id };
		});
	});
	const unique = new Map<string, Channel>();
	for (const item of items) {
		let id: string | undefined;
		if (item.kind === "link") {
			try {
				const link = new URL(item.href!);
				if (link.origin !== ORIGIN || link.search || link.hash || link.username || link.password) continue;
				id = link.pathname.match(new RegExp(`^/client/${TEAM_ID}/([CG][A-Z0-9]{8,})$`))?.[1];
			} catch { continue; }
		} else {
			// Slack's current sidebar renders channel rows rather than anchors.
			// Read DOM IDs and labels only. Exclude DMs, unknown types, and drift.
			if (!["channel", "group"].includes(item.type ?? "")) continue;
			if (!item.id || !/^[CG][A-Z0-9]{8,}$/.test(item.id) || !item.identityMatches || !item.name) throw new ReaderError("ui_changed");
			id = item.id;
		}
		if (id && item.name) unique.set(id, { id, name: redact(item.name) });
	}
	if (!unique.size) throw new ReaderError("ui_changed");
	return [...unique.values()];
}

export function linkedMessageSelector(args: Args): string {
	if (!args.message || !/^\d{10}\.\d{6}$/.test(args.message)) throw new ReaderError("bad_arguments");
	const message = `:is(${selectors.messages})`;
	const digits = args.message.replace(".", "");
	const exact = `${message}:is([data-msg-ts="${args.message}"], [data-ts="${args.message}"], [data-message-id="${args.message}"]), [data-item-key="${args.message}"] ${message}, ${message}:has(a[href*="/archives/${args.channel}/p${digits}"])`;
	if (!args.thread) return exact;
	return `${selectors.thread.split(", ").map(root => `${root} :is(${exact})`).join(", ")}, .c-message_kit__thread_message:is(${exact})`;
}

export function assertRequestedView(args: Args, url: string): void {
	if (args.command === "read") {
		try {
			const actual = new URL(url);
			const base = `/client/${TEAM_ID}/${args.channel}`;
			if (actual.origin !== ORIGIN || actual.username || actual.password || actual.hash) throw new ReaderError("ui_changed");
			if (actual.searchParams.has("message_ts") && actual.searchParams.get("message_ts") !== args.message) throw new ReaderError("ui_changed");
			if (args.thread) {
				const queryThread = actual.pathname === base && actual.searchParams.get("thread_ts") === args.thread
					&& (!actual.searchParams.has("cid") || actual.searchParams.get("cid") === args.channel);
				if (actual.pathname !== `${base}/thread/${args.channel}-${args.thread}` && !queryThread) throw new ReaderError("ui_changed");
			} else if (actual.pathname !== base) throw new ReaderError("ui_changed");
			return;
		} catch { throw new ReaderError("ui_changed"); }
	}
	if (!["history", "replies", "search"].includes(args.command)) return;
	try {
		const actual = new URL(url);
		const requested = new URL(readURL(args));
		if (actual.origin !== requested.origin || actual.pathname !== requested.pathname
			|| (args.command === "search" && actual.searchParams.get("q") !== args.query)) throw new ReaderError("ui_changed");
	} catch { throw new ReaderError("ui_changed"); }
}

export async function readUI(args: Args, session: Session, signal?: AbortSignal): Promise<Result> {
	if (signal?.aborted) throw new ReaderError("cancelled");
	const page = session.page;
	if (page.url() !== "about:blank") {
		await checkPage(session);
		await verifyLogin(session, false, signal);
	}
	if (signal?.aborted) throw new ReaderError("cancelled");
	const url = readURL(args);
	if (page.url() !== url) {
		try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); }
		catch (error) {
			await checkPage(session);
			throw new ReaderError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_failure");
		}
	}
	await checkPage(session);
	const result: Result = { schema_version: 1, ok: true, command: args.command, team_id: TEAM_ID, source: "headed_ui", data: {},
		coverage: { complete: false, reason: "rendered_messages_only", returned: 0, limit: args.limit, pagination: "none", order: "rendered" } };
	if (args.command === "read") {
		assertRequestedView(args, page.url());
		const selector = linkedMessageSelector(args);
		await waitRendered(session, selector, undefined, 12_000, signal);
		assertRequestedView(args, page.url());
		const message = (await extractMessages(page, selector)).find(item => item.ts === args.message);
		if (!message) throw new ReaderError("ui_changed");
		result.data = { message, messages: [message] };
		result.coverage = { ...result.coverage, reason: "linked_message_only", returned: 1 };
	} else if (args.command === "doctor") {
		await verifyLogin(session, false, signal);
		result.data.session_verified = true;
		result.coverage = { ...result.coverage, complete: true, reason: "point_in_time_ui_verification", returned: 1 };
	} else if (args.command === "channels") {
		// Workspace chrome can appear before the virtualized channel rows load.
		await waitRendered(session, selectors.channelItems, undefined, 12_000, signal);
		result.data.channels = (await extractChannels(page)).slice(0, args.limit);
		result.coverage.reason = "rendered_joined_channels_only";
		result.coverage.returned = result.data.channels.length;
	} else {
		let selector: string = selectors.messages;
		let empty: string | undefined = selectors.emptyHistory;
		if (args.command === "replies") selector = `${selectors.thread.split(", ").map(root => selectors.messages.split(", ").map(s => `${root} ${s}`).join(", ")).join(", ")}, .c-message_kit__thread_message[data-qa="message_container"]`;
		if (args.command === "search") { selector = selectors.searchMessages; empty = selectors.noResults; }
		assertRequestedView(args, page.url());
		await waitRendered(session, selector, empty, 12_000, signal);
		assertRequestedView(args, page.url());
		let messages = await extractMessages(page, selector);
		if (!messages.length && !(empty && await page.locator(empty).first().isVisible())) throw new ReaderError("ui_changed");
		if (args.after || args.before) {
			if (messages.some(m => !m.ts)) throw new ReaderError("ui_changed");
			messages = messages.filter(m => (!args.after || Number(m.ts) >= Date.parse(`${args.after}T00:00:00Z`) / 1000)
				&& (!args.before || Number(m.ts) < Date.parse(`${args.before}T00:00:00Z`) / 1000));
		}
		// No scroll, search form submission, message composer input, or writes.
		result.data.messages = messages.slice(0, args.limit);
		result.coverage.returned = result.data.messages.length;
		if (args.command === "search") result.coverage.reason = "rendered_search_results_only";
		if (args.command === "replies") result.coverage.reason = "rendered_thread_messages_only";
	}
	if (signal?.aborted) throw new ReaderError("cancelled");
	await checkPage(session);
	assertRequestedView(args, page.url());
	return result;
}
