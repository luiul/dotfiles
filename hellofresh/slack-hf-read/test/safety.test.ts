import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { acquireSession, validLocalListener, type SessionDependencies } from "../src/session.ts";
import { parseArgs, readURL } from "../src/args.ts";
import { assertRequestedView } from "../src/ui.ts";
import type { StateStore } from "../src/state.ts";

function harness() {
	class MockPage extends EventEmitter {
		id: string;
		location: string;
		closed = false;
		constructor(id: string, location: string) { super(); this.id = id; this.location = location; }
		url() { return this.location; }
		isClosed() { return this.closed; }
		async close() { this.closed = true; }
		setDefaultTimeout() {}
	}
	const holder = new MockPage("holder", "https://app.slack.com/client/T02AGMUUR");
	const reader = new MockPage("reader", "https://app.slack.com/client/T02AGMUUR/C11111111");
	let pages = [holder, reader];
	let disconnected = false;
	const state = { schema_version: 1, paused: false, events: [], browser: { pid: 1, started: "test", profile: "/test", holder_id: "holder", target_id: "reader" } };
	const store = { read: async () => structuredClone(state), write: async (value: typeof state) => { Object.assign(state, value); } } as unknown as StateStore;
	const context = { pages: () => pages, newPage: async () => { throw new Error("Unexpected tab creation"); } };
	const deps = { connect: async () => ({ contexts: () => [context], close: async () => { disconnected = true; } }), targetID: async (page: MockPage) => page.id } as unknown as SessionDependencies;
	return { holder, reader, store, deps, state, setPages(value: MockPage[]) { pages = value; }, disconnected: () => disconnected };
}

test("listener must belong to the exact IPv4 loopback endpoint", () => {
	const header = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n";
	const row = "Brave 123 user 1u IPv4 0x1 0t0 TCP ";
	assert.equal(validLocalListener(header + row + "127.0.0.1:9223 (LISTEN)"), true);
	for (const address of ["[::1]", "*", "0.0.0.0", "192.168.1.1"]) assert.equal(validLocalListener(header + row + `${address}:9223 (LISTEN)`), false);
	assert.equal(validLocalListener(header), false);
});

test("missing recorded holder is never replaced by the retained reader", async () => {
	const h = harness(); h.setPages([h.reader]);
	await assert.rejects(acquireSession(h.store, "/test", true, h.deps), { code: "session_needed" });
	assert.equal(h.state.browser.holder_id, "holder");
	assert.equal(h.reader.closed, false);
	assert.equal(h.disconnected(), true);
});

test("a reader target can never become the protected holder", async () => {
	const h = harness(); h.state.browser.holder_id = "reader";
	await assert.rejects(acquireSession(h.store, "/test", false, h.deps), { code: "state_invalid" });
	assert.equal(h.reader.closed, false);
	assert.equal(h.holder.closed, false);
});

test("pre-existing external SSO redirect is auth loss, not a repeatable origin error", async () => {
	const h = harness(); h.reader.location = "https://sso.example.invalid/login";
	await assert.rejects(acquireSession(h.store, "/test", false, h.deps), { code: "auth_lost" });
	assert.equal(h.reader.closed, true);
	assert.equal(h.holder.closed, false);
	assert.equal(h.disconnected(), true);
});

test("401 auth loss stays sticky when followed by 429", async () => {
	const h = harness(); const session = await acquireSession(h.store, "/test", false, h.deps);
	h.reader.emit("response", { url: () => "https://app.slack.com/api/client.boot", status: () => 401 });
	h.reader.emit("response", { url: () => "https://app.slack.com/api/client.boot", status: () => 429 });
	assert.throws(() => session.check(), { code: "auth_lost" });
	await session.close(true);
	assert.equal(h.reader.closed, true);
	assert.equal(h.holder.closed, false);
	assert.equal(h.reader.listenerCount("response"), 0);
	assert.equal(h.reader.listenerCount("framenavigated"), 0);
});

test("login observes only the holder and never closes it", async () => {
	const h = harness(); h.holder.location = "https://sso.example.invalid/login";
	const session = await acquireSession(h.store, "/test", true, h.deps);
	assert.equal(session.page, h.holder);
	assert.equal(session.observingLogin, true);
	session.check();
	await session.close(true);
	assert.equal(h.holder.closed, false);
	assert.equal(h.reader.closed, false);
});

test("holder auth loss cannot be hidden by a surviving reader", async () => {
	const h = harness(); h.holder.location = "https://hellofresh.slack.com/";
	await assert.rejects(acquireSession(h.store, "/test", false, h.deps), { code: "auth_lost" });
	assert.equal(h.reader.closed, true);
	assert.equal(h.holder.closed, false);
});

test("read redirects outside Slack stop and signal auth loss", async () => {
	const h = harness(); const session = await acquireSession(h.store, "/test", false, h.deps);
	h.reader.location = "https://sso.example.invalid/login";
	h.reader.emit("framenavigated", { parentFrame: () => null });
	assert.throws(() => session.check(), { code: "auth_lost" });
	await session.close(true);
});

test("requested history, thread, and search views must match exactly", () => {
	const history = parseArgs(["history", "C11111111"]);
	const replies = parseArgs(["replies", "C11111111", "1790812800.000002"]);
	const search = parseArgs(["search", "in:general deployment"]);
	for (const args of [history, replies, search]) assert.doesNotThrow(() => assertRequestedView(args, readURL(args)));
	assert.throws(() => assertRequestedView(history, "https://app.slack.com/client/T02AGMUUR/C22222222"), { code: "ui_changed" });
	assert.throws(() => assertRequestedView(replies, readURL(replies).replace("1790812800.000002", "1790812800.000003")), { code: "ui_changed" });
	assert.throws(() => assertRequestedView(search, readURL(search).replace("deployment", "other")), { code: "ui_changed" });
});
