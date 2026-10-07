import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parsePermalink, readURL } from "../src/args.ts";
import { assertRequestedView } from "../src/ui.ts";

const url = "https://hellofresh.slack.com/archives/C08F2524HD0/p1791299508307459?thread_ts=1790955451.078149&cid=C08F2524HD0";

test("supplied permalink parses exact message and thread identities", () => {
	const args = parseArgs(["read", url, "--limit", "5"]);
	assert.equal(args.channel, "C08F2524HD0");
	assert.equal(args.message, "1791299508.307459");
	assert.equal(args.thread, "1790955451.078149");
	assert.equal(readURL(args), "https://app.slack.com/client/T02AGMUUR/C08F2524HD0?message_ts=1791299508.307459&thread_ts=1790955451.078149&cid=C08F2524HD0");
	assert.doesNotThrow(() => assertRequestedView(args, readURL(args)));
	assert.throws(() => assertRequestedView(args, url), { code: "ui_changed" });
	assert.doesNotThrow(() => assertRequestedView(args, "https://app.slack.com/client/T02AGMUUR/C08F2524HD0/thread/C08F2524HD0-1790955451.078149"));
	assert.throws(() => assertRequestedView(args, "https://app.slack.com/client/T02AGMUUR/C08F2524HD0/thread/C08F2524HD0-1790955451.078150"), { code: "ui_changed" });
});

for (const unsafe of [
	url.replace("https:", "http:"), url.replace("hellofresh.slack.com", "evil.slack.com"),
	url.replace("hellofresh.slack.com", "hellofresh.slack.com.evil"), url.replace("https://", "https://user:secret@"),
	url.replace(".com/", ".com:9223/"), url + "#fragment", url + "&token=secret", url + "&thread_ts=1790955451.078149",
	url.replace("cid=C08F2524HD0", "cid=C11111111"), url.replace("1790955451.078149", "1.2"),
	url.replace("p1791299508307459", "p1791299508"), " https://hellofresh.slack.com/archives/C08F2524HD0/p1791299508307459",
]) {
	test(`invalid permalink is rejected before browser activity (${unsafe.length})`, () => {
		assert.throws(() => parsePermalink(unsafe), { code: "bad_arguments" });
	});
}

test("channel permalink without thread validates only its own channel view", () => {
	const args = parseArgs(["read", url.split("?")[0]]);
	assert.equal(args.thread, undefined);
	assert.doesNotThrow(() => assertRequestedView(args, "https://app.slack.com/client/T02AGMUUR/C08F2524HD0"));
	assert.throws(() => assertRequestedView(args, "https://app.slack.com/client/T02AGMUUR/C11111111"), { code: "ui_changed" });
});
