// Unit tests for the split extension's sticky user prompt bar
// (split-sticky.ts: StickyPromptBar + findTranscriptScrollView).
//
// Pins the VS Code sticky-scroll contract over a real ScrollView:
// - hidden at the transcript top (prompt on screen) and above the first
//   prompt;
// - shows the user prompt OWNING the top visible line (the last prompt
//   whose block starts above the viewport top), walking turn by turn as
//   the viewport moves through history;
// - hides again when the owning prompt's first line is exactly the top
//   visible row (start == scrollTop — never pin what is on screen);
// - max 3 text rows + 1 separator row, ellipsis when truncated, every row
//   padded to exactly the column width;
// - the native transcript doc shape (header containers + nested chat
//   container) resolves the same as the flat response doc shape;
// - components after the last prompt are never measured, so a mutating
//   streaming tail cannot change the pinned prompt or crash the walk;
// - findTranscriptScrollView picks the ScrollView entry, not the dock.
//
// Run: bun scripts/test-split-sticky.ts
import { Container, ScrollView, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import {
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";

// UserMessageComponent renders through the global pi theme; a bare bun run
// must install one first (pi's TUI normally does this at startup).
initTheme("system");

const { StickyPromptBar, findTranscriptScrollView } = await import(
	"../pi/.pi/agent/extensions/split-sticky.ts"
);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
	}
}

/** Pass-through mock theme: rows come back plain for string assertions. */
const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
} as never;

/** Fake non-user block: renders n rows. */
function block(n: number) {
	return {
		n,
		render: (_w: number) => Array.from({ length: n }, () => "x"),
		invalidate() {},
		dispose() {},
	};
}

/** Mutable fake block (simulates a streaming tail changing height). */
function mutableBlock(n: number) {
	return {
		n,
		render(_w: number) {
			return Array.from({ length: this.n }, () => "x");
		},
		invalidate() {},
		dispose() {},
	};
}

const W = 60;
const VP = 10; // viewport rows

function mkUser(text: string) {
	return new UserMessageComponent(text, getMarkdownTheme());
}

function totalHeight(doc: Container, w: number) {
	return doc.children.reduce((s, c) => s + Math.max(1, c.render(w).length), 0);
}

/** Height of everything in doc before the given child. */
function offsetBefore(doc: Container, child: unknown, w: number) {
	let off = 0;
	for (const c of doc.children) {
		if (c === child) return off;
		off += Math.max(1, c.render(w).length);
	}
	return -1;
}

function bar(source: () => unknown) {
	return new StickyPromptBar(theme, source as never);
}

const plain = (rows: string[]) => rows.map((r) => r.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));

// --- flat (response-doc) shape ---------------------------------------------------
{
	// doc: [spacer, u1, b8, spacer, u2, tail30, spacer]
	const u1 = mkUser("first prompt");
	const u2 = mkUser("second prompt");
	const tail = mutableBlock(30);
	const doc = new Container();
	doc.addChild(new Spacer(1));
	doc.addChild(u1);
	doc.addChild(block(8));
	doc.addChild(new Spacer(1));
	doc.addChild(u2);
	doc.addChild(tail);
	doc.addChild(new Spacer(1));

	const sv = new ScrollView(doc, { follow: "none" });
	sv.updateLayout(totalHeight(doc, W), VP, () => {});
	const b = bar(() => ({ sv, doc }));

	sv.scrollTo(0);
	check("hidden at the very top (nothing pinned)", b.render(W).length === 0);

	// One row inside u1's response: top line owned by u1, but u1's own first
	// line is still on screen (start >= scrollTop) → hidden.
	sv.scrollTo(offsetBefore(doc, u1, W));
	check("hidden when the prompt's first line IS the top visible row", b.render(W).length === 0);

	// Deep inside the last turn: u2 owns the top line, pinned.
	sv.scrollTo(1e9); // clamps to end
	const rows = plain(b.render(W));
	check("pinned while following the end", rows.some((r) => r.includes("second prompt")), rows[0]);
	check("rows padded to exactly the column width", b.render(W).every((r) => visibleWidth(r) === W));
	check("separator row closes the pinned block", rows[rows.length - 1].startsWith("─"), rows[rows.length - 1]);
	check("old turn's prompt is NOT pinned", !rows.some((r) => r.includes("first prompt")), rows[0]);

	// Scrolling up into the first turn switches the pinned prompt.
	sv.scrollTo(offsetBefore(doc, u1, W) + Math.max(1, u1.render(W).length) + 4);
	const rowsMid = plain(b.render(W));
	check("pinned prompt walks turn by turn when scrolling", rowsMid.some((r) => r.includes("first prompt")) && !rowsMid.some((r) => r.includes("second prompt")), rowsMid[0]);

	// The streaming tail mutates AFTER the last prompt: never measured, so
	// the pinned prompt and offsets must be unaffected.
	sv.scrollTo(1e9);
	const before = plain(b.render(W));
	tail.n = 3;
	const after = plain(b.render(W));
	check("mutating tail after the last prompt changes nothing", JSON.stringify(before) === JSON.stringify(after));

	// Width change: re-measures, still correct.
	sv.scrollTo(1e9);
	const rowsWide = plain(b.render(80));
	check("re-measures at a new width", rowsWide.some((r) => r.includes("second prompt")) && b.render(80).every((r) => visibleWidth(r) === 80));

	// A doc without any text-bearing user message: never pins.
	const doc2 = new Container();
	doc2.addChild(block(4));
	doc2.addChild(mkUser("   ")); // whitespace-only: not a pin candidate
	doc2.addChild(block(8));
	const sv2 = new ScrollView(doc2, { follow: "none" });
	sv2.updateLayout(totalHeight(doc2, W), VP, () => {});
	sv2.scrollTo(1e9);
	check("empty/whitespace prompts never pin", bar(() => ({ sv: sv2, doc: doc2 })).render(W).length === 0);
}

// --- native (transcript) doc shape -----------------------------------------------
{
	// documentContainer: [header(3 rows), loadedResources(2 rows), chat]
	const u1 = mkUser("first prompt");
	const u2 = mkUser("second prompt");
	const chat = new Container();
	chat.addChild(u1);
	chat.addChild(block(8));
	chat.addChild(u2);
	chat.addChild(mutableBlock(30));
	const nativeDoc = new Container();
	nativeDoc.addChild(block(3));
	nativeDoc.addChild(block(2));
	nativeDoc.addChild(chat);

	const sv = new ScrollView(nativeDoc, { follow: "none" });
	sv.updateLayout(totalHeight(nativeDoc, W), VP, () => {});
	const b = bar(() => ({ sv, doc: nativeDoc }));

	sv.scrollTo(0);
	check("native shape: hidden at top", b.render(W).length === 0);

	sv.scrollTo(1e9);
	const rows = plain(b.render(W));
	check("native shape: pins the last prompt at the end", rows.some((r) => r.includes("second prompt")), rows[0]);

	// Above the first prompt (inside the header): nothing owns the top line.
	sv.scrollTo(1);
	check("native shape: hidden above the first prompt", b.render(W).length === 0);

	// Header heights (3+2) must be part of u1's start offset: scrolling just
	// past them pins u1.
	sv.scrollTo(6);
	const rowsEarly = plain(b.render(W));
	check("native shape: header rows count toward prompt offsets", rowsEarly.some((r) => r.includes("first prompt")), rowsEarly[0]);
}

// --- truncation ------------------------------------------------------------------
{
	const long = "word ".repeat(60).trim();
	const u = mkUser(long);
	const doc = new Container();
	doc.addChild(u);
	doc.addChild(mutableBlock(40));
	const sv = new ScrollView(doc, { follow: "none" });
	sv.updateLayout(totalHeight(doc, W), VP, () => {});
	sv.scrollTo(1e9);
	const raw = bar(() => ({ sv, doc })).render(W);
	check("long prompt pinned to at most 4 rows (3 text + separator)", raw.length === 4, raw.length);
	const rows = plain(raw);
	check("truncated row ends with an ellipsis", rows[2].trimEnd().endsWith("…"), rows[2]);
	check("truncation keeps rows at exact width", raw.every((r) => visibleWidth(r) === W));
}

// --- findTranscriptScrollView ----------------------------------------------------
{
	const svChild = new Container();
	const sv = new ScrollView(svChild, {});
	const dock = new Container();
	const { VStack } = await import("@earendil-works/pi-tui");
	const root = new VStack([
		{ component: sv, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	check("finds the ScrollView entry, not the dock", findTranscriptScrollView(root) === sv);
	check("returns null for a non-stack root", findTranscriptScrollView(new Container()) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
