// Unit tests for the zen extension (transcript filter, extensions/zen.ts):
// - loadFilterOn/saveFilterOn: strict typing (garbage JSON never flips the
//   filter), default ON, roundtrip, via the module's test seam.
// - walkTranscript: finds the message subtree through the layout-root shape,
//   visits every node once, survives throwing nodes and cycles, no-ops on a
//   tree that does not match (fail-open).
// - shouldHideTool: the policy core — hide successful tool calls while the
//   filter is on; failed calls stay visible; never hide while off.
//
// Run: bun scripts/test-zen-extension.ts
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Config path redirected via the module's test seam (bun's os.homedir()
// ignores $HOME, so a temp-HOME override does not work — never write the
// real ~/.pi/agent/zen.json from tests).
const TMP = mkdtempSync(join(tmpdir(), "zen-"));

const {
	loadFilterOn,
	saveFilterOn,
	walkTranscript,
	shouldHideTool,
	__setConfigPathForTest,
} = await import("../pi/.pi/agent/extensions/zen.ts");

__setConfigPathForTest(join(TMP, "zen.json"));

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

// --- config -----------------------------------------------------------------------
{
	check("no config file: filter defaults ON", loadFilterOn() === true);
	check("save ON roundtrip", saveFilterOn(true) && loadFilterOn() === true);
	check("save OFF roundtrip", saveFilterOn(false) && loadFilterOn() === false);
	writeFileSync(join(TMP, "zen.json"), JSON.stringify({ filter: true }, null, 2));
	check("explicit true honored", loadFilterOn() === true);
	// Strict typing: garbage shapes must fall back to the default, never throw.
	for (const raw of [null, [], "no", 42, {}, { filter: "yes" }, { filter: 1 }, { filter: null }]) {
		writeFileSync(join(TMP, "zen.json"), JSON.stringify(raw));
		check(`garbage tolerated: ${JSON.stringify(raw)}`, loadFilterOn() === true);
	}
	writeFileSync(join(TMP, "zen.json"), "{ broken json");
	check("broken JSON tolerated", loadFilterOn() === true);
}

// --- fake component tree ------------------------------------------------------------
// Shape mirrors pi 1.4.0: layoutRoot.entries[*].component (ScrollView with
// .child) → container subtree holding AssistantMessageComponent-like and
// ToolExecutionComponent-like nodes.
class Node {
	children: Node[] = [];
	[k: string]: unknown;
	constructor(
		public kind: "root" | "sv" | "assistant" | "tool" | "other" | "boom",
		opts: Record<string, unknown> = {},
	) {
		Object.assign(this, { kind }, opts);
	}
}
const asst = (opts: Record<string, unknown> = {}) => {
	const n = new Node("assistant", opts);
	(n as any).setHideThinkingBlock = (hide: boolean) => {
		(n as any).hideThinkingBlock = hide;
	};
	return n;
};
const tool = (opts: Record<string, unknown> = {}) => {
	const n = new Node("tool", { hideComponent: false, ...opts });
	(n as any).toolCallId = String(opts.toolCallId ?? "tc-1");
	return n;
};
const tuiWith = (child: unknown) => ({
	layoutRoot: {
		entries: [
			{ component: { child } },
			{ component: { noChildHere: true } },
		],
	},
});

{
	const a1 = asst();
	const t1 = tool();
	const t2 = tool({ toolCallId: "tc-2" });
	const inner = new Node("other", {}, []);
	inner.children.push(t1);
	const chat = new Node("other");
	chat.children.push(a1, inner, t2);
	const visited: string[] = [];
	walkTranscript(tuiWith(chat), (k) => visited.push(k.kind));
	check(
		"walk visits the subtree, not the entry list",
		visited.filter((k) => k === "assistant").length === 1 && visited.includes("tool"),
		visited,
	);
	check("no child-holding entry: walk no-ops (fail-open)", (() => {
		const seen: string[] = [];
		walkTranscript({ layoutRoot: { entries: [{ component: { other: 1 } }] } }, (k) => seen.push(k.kind));
		return seen.length === 0;
	})());
	check("missing layoutRoot: no throw", (() => {
		walkTranscript({}, () => check("never called", false));
		return true;
	})());
}

{
	// A node whose children access throws, plus a visiting order that would
	// loop: the seen set and per-node catch must keep the walk total.
	const cycA = new Node("other");
	const cycB = new Node("other");
	cycA.children.push(cycB);
	cycB.children.push(cycA);
	const boom = new Node("boom");
	Object.defineProperty(boom, "children", { get: () => { throw new Error("boom"); } });
	const chat = new Node("other");
	chat.children.push(cycA, boom);
	let count = 0;
	let threw = false;
	try {
		walkTranscript(tuiWith(chat), () => {
			count++;
			if (count === 1) throw new Error("visitor throws on first node");
		});
	} catch {
		threw = true;
	}
	check("throwing nodes/visitor never abort the walk", !threw && count >= 3, { threw, count });
}

{
	// Each node visited exactly once despite the cycle.
	const cycA = new Node("other");
	const cycB = new Node("other");
	cycA.children.push(cycB);
	cycB.children.push(cycA);
	const counts = new Map<object, number>();
	walkTranscript(tuiWith(cycA), (k) => counts.set(k, (counts.get(k) ?? 0) + 1));
	check("seen set: one visit per node", [...counts.values()].every((c) => c === 1), [...counts.values()]);
}

// --- shouldHideTool: the policy core ------------------------------------------------
{
	const ok = tool();
	const failed = tool({ result: { isError: true } });
	const notATool = new Node("other");
	check("filter on: successful call hidden", shouldHideTool(ok, true) === true);
	check("filter on: FAILED call stays visible", shouldHideTool(failed, true) === false);
	check("filter off: nothing hidden", shouldHideTool(ok, false) === false && shouldHideTool(failed, false) === false);
	check("non-tool node never hidden", shouldHideTool(notATool, true) === false);
	check(
		"duck-typing: a node with toolCallId but no hideComponent is not a tool",
		shouldHideTool({ toolCallId: "x" }, true) === false,
	);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nzen extension unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
