// Unit tests for the split extension's transient status mirror
// (split-status.ts): the per-frame watch that rescues extension ui.notify
// output and pi's own transient statuses in response-only mode.
//
// Contracts pinned here:
// - Attach starts at the tail: history already in the watched containers is
//   never mirrored, only children appended after the first poll.
// - A new status line (ThemedText duck: build() + render()) is mirrored into
//   the response doc with a blank Spacer row above, exactly like showStatus
//   lays it out in pi's transcript.
// - Children that are not status lines (no build closure) are skipped.
// - The mirror appends the COMPONENT INSTANCE, not extracted text, so pi's
//   back-to-back status replacement (showStatus reuses the last ThemedText
//   instead of appending) never duplicates rows — identity is the assertion.
// - While inactive (response-only mode off), polling is a no-op.
// - resetStatusMirror() drops the watch state: the next poll re-attaches at
//   the current tail.
//
// Run: bun scripts/test-split-status.ts
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getResponseDoc, responseDocBegin } from "../pi/.pi/agent/extensions/split/split-response.ts";
import {
	initStatusMirror,
	pollStatusLines,
	resetStatusMirror,
} from "../pi/.pi/agent/extensions/split/split-status.ts";

let failures = 0;
const check = (name: string, cond: boolean) => {
	if (cond) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`  FAIL  ${name}`);
	}
};

// A ThemedText duck: pi's wrapper class is internal, the mirror must not
// depend on instanceof across pi's bundled pi-tui copy.
const statusText = (msg: string): any => ({
	build: () => msg,
	render: (w: number) => [msg.repeat(Math.min(1, w))],
	constructor: { name: "ThemedText" },
});
const noiseChild = (): any => ({ render: (w: number) => ["x"], constructor: { name: "Component" } });

// Fake transcript subtree shaped like the real one: base root → entries →
// ScrollView (has `child`) → content container with children.
const makeBase = (chat: any) => ({
	entries: [{ component: { child: chat } }],
});

const docRowCount = () => getResponseDoc().children.length;
const docTexts = () =>
	getResponseDoc().children.filter((c: any) => typeof c?.build === "function").map((c: any) => c.build());

// ── 1. attach at the tail, mirror only new status lines ──────────────────────
{
	responseDocBegin();
	const chat = { children: [noiseChild(), statusText("history status")] };
	initStatusMirror(() => makeBase(chat), () => true);
	resetStatusMirror();
	pollStatusLines(); // attach pass
	const before = docRowCount();
	check("attach mirrors nothing from history", docRowCount() === before && before === 0);

	chat.children.push(statusText("Right column on"));
	const mirrored = pollStatusLines();
	check("new status line is mirrored", mirrored);
	check("mirrored row plus spacer landed in the doc", docRowCount() === 2);
	check("doc holds the status text", docTexts().includes("Right column on"));

	chat.children.push(noiseChild());
	const mirrored2 = pollStatusLines();
	check("non-status children are skipped", !mirrored2 && docRowCount() === 2);
}

// ── 2. back-to-back replacement stays one row (instance identity) ─────────
{
	responseDocBegin();
	const chat = { children: [] };
	initStatusMirror(() => makeBase(chat), () => true);
	resetStatusMirror();
	pollStatusLines();
	const reused = statusText("first");
	chat.children.push(reused);
	pollStatusLines();
	check("first back-to-back status mirrored", docRowCount() === 2);
	// pi's showStatus updates the SAME instance instead of appending.
	chat.children[chat.children.length - 1] = { ...reused, build: () => "second" };
	chat.children.push(noiseChild());
	pollStatusLines();
	const texts = docTexts();
	check("reused instance is not mirrored again", docRowCount() === 2);
}

// ── 3. inactive mirror is a no-op ───────────────────────────────────────────
{
	responseDocBegin();
	const chat = { children: [] };
	initStatusMirror(() => makeBase(chat), () => false);
	resetStatusMirror();
	pollStatusLines();
	chat.children.push(statusText("Split off (bare layout)"));
	check("inactive mirror appends nothing", !pollStatusLines() && docRowCount() === 0);
}

// ── 4. reset re-attaches at the new tail ───────────────────────────────────
{
	responseDocBegin();
	const chat = { children: [statusText("pre-reset")] };
	initStatusMirror(() => makeBase(chat), () => true);
	resetStatusMirror();
	pollStatusLines(); // attach
	chat.children.push(statusText("post-reset"));
	pollStatusLines(); // mirrors post-reset
	check("pre-reset attached tail honored", docTexts().includes("post-reset"));
	resetStatusMirror();
	pollStatusLines(); // re-attach at current tail
	chat.children.push(statusText("after-reattach"));
	pollStatusLines();
	const texts = docTexts();
	check("re-attach skips earlier history", !texts.includes("pre-reset"));
	check("re-attach mirrors new rows", texts.includes("after-reattach"));
}

// ── 5. Spacer and Text imports still resolve (used by the mirror) ─────────
check("pi-tui exports used by the mirror exist", typeof Spacer === "function" && typeof Text === "function");

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
console.log("all split-status tests passed");
