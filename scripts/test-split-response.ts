// Unit tests for the split extension's response-only view (split-response.ts):
// bash blocks, skill turns, compaction, branch summaries, custom display
// messages, live bang-command flow, and the per-frame leaf walk.
//
// Contracts pinned here:
// - `!`/`!!` bang results rebuild into the response doc with full native
//   parity: `$ command`, output, `(exit N)`, dim for `!!` (its own component
//   colorKey), nothing dropped.
// - A running bang command (user_bash) shows a live block, and the leaf walk
//   completes it from the appended branch entry — no extension event exists,
//   the walk is the only public-API path.
// - Skill turns: the doc shows only the real user prompt, never the raw
//   <skill …> block; the Tool Usage panel gets the `skill: <name>` event row.
// - Compaction clears the doc (native parity) and logs a panel event row.
// - Branch summaries and custom display messages become panel event rows,
//   never doc noise; custom messages without display are dropped.
// - The walk never double-adds a user/assistant message that the live message
//   stream already ingested (WeakSet dedupe), and no-ops when the leaf did
//   not move or when the cursor is off the ancestry (rebuild owns that case).
// - toolsPanel.ingestEvent dedupes by id.
//
// Run: bun scripts/test-split-response.ts
import {
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// UserMessageComponent renders through the global pi theme; a bare bun run
// must install one first (pi's TUI normally does this at startup).
initTheme("system");

const {
	setResponseTui,
	responseDocBegin,
	responseDocEnd,
	responseIngestEntry,
	responseMessageStart,
	startLiveBash,
	syncBranchEntries,
	getResponseDoc,
	resetResponseState,
} = await import("../pi/.pi/agent/extensions/split-response.ts");
const { toolsPanel } = await import(
	"../pi/.pi/agent/extensions/split-panels.ts"
);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(
			`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
		);
	}
}

/** Pass-through mock theme: rows come back plain for string assertions. */
const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
} as never;

const W = 70;

/** Strip ANSI styling so assertions see plain text. */
function plain(rows: string[]): string[] {
	return rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** Render every doc child and return the concatenated plain rows. */
function docRows(): string[] {
	const out: string[] = [];
	for (const c of getResponseDoc().children as any[]) {
		try {
			out.push(...plain(c.render(W)));
		} catch {
			/* child render failure is itself a failure */
			out.push("<render error>");
		}
	}
	return out;
}

function panelRows(): string[] {
	return plain(toolsPanel.lines(theme, W));
}

// ─── fake branch / ctx ───────────────────────────────────────────────────────

interface FakeEntry {
	id: string;
	parentId?: string;
	type: string;
	message?: any;
	[key: string]: unknown;
}

function fakeCtx(entries: FakeEntry[], leafId: string) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	return {
		sessionManager: {
			getBranch: () => entries,
			getLeafId: () => leafId,
			getEntry: (id: string) => byId.get(id),
		},
	} as never;
}

function msgEntry(id: string, parentId: string, message: any): FakeEntry {
	return { id, parentId, type: "message", message };
}

setResponseTui({ requestRender: () => {} });
toolsPanel.reset();

// ─── 1. bash blocks rebuild into the doc with native parity ──────────────────

{
	toolsPanel.reset();
	responseDocBegin();
	const entries: FakeEntry[] = [
		msgEntry("e1", "e0", { role: "user", content: "run gurl" }),
		msgEntry("e2", "e1", {
			role: "bashExecution",
			command: "gurl",
			output: "/bin/bash: gurl: command not found\n",
			exitCode: 127,
			cancelled: false,
			truncated: false,
			timestamp: 1,
			excludeFromContext: false,
		}),
		msgEntry("e3", "e2", {
			role: "bashExecution",
			command: "echo ok",
			output: "ok\n",
			exitCode: 0,
			timestamp: 2,
			excludeFromContext: false,
		}),
		msgEntry("e4", "e3", {
			role: "bashExecution",
			command: "secret",
			output: "hidden\n",
			exitCode: 0,
			timestamp: 3,
			excludeFromContext: true,
		}),
	];
	for (const e of entries) responseIngestEntry(e);
	responseDocEnd(fakeCtx(entries, "e4"));
	const rows = docRows().join("\n");
	check("bash: doc shows $ gurl", rows.includes("$ gurl"));
	check("bash: doc shows the output", rows.includes("command not found"));
	check("bash: doc shows (exit 127)", rows.includes("(exit 127)"));
	check("bash: exit 0 block has no exit marker", !rows.includes("(exit 0)"));
	check("bash: !! block still visible (dim, not dropped)", rows.includes("$ secret"));
	check(
		"bash: user message rendered too",
		docRows().length > 0 && rows.includes("run gurl"),
	);
}

// ─── 2. skill turns: user prompt only, invocation row in the panel ───────────

{
	toolsPanel.reset();
	responseDocBegin();
	const skillText =
		'<skill name="demo-skill" location="/skills/demo/SKILL.md">\nYou are a demo skill prompt.\n</skill>\n\nwhat is up doc?';
	const msg = { role: "user", content: skillText };
	const entry = msgEntry("s1", "s0", msg);
	responseIngestEntry(entry);
	const rows = docRows().join("\n");
	check("skill: doc shows the real user prompt", rows.includes("what is up doc?"));
	check("skill: raw <skill block never leaks into the doc", !rows.includes("<skill"));
	const panel = panelRows().join("\n");
	check("skill: panel gets a skill event row", panel.includes("skill: demo-skill"));
	check(
		"skill: panel full mode shows the skill prompt body",
		(() => {
			toolsPanel.setMode("full");
			const full = panelRows().join("\n");
			toolsPanel.setMode("compact");
			return full.includes("demo skill prompt");
		})(),
	);

	// Skill with no user prompt: doc empty, panel row only.
	toolsPanel.reset();
	responseDocBegin();
	responseIngestEntry(
		msgEntry("s2", "s0", {
			role: "user",
			content:
				'<skill name="no-msg" location="/x">\nprompt only\n</skill>',
		}),
	);
	check(
		"skill: no-userMessage turn leaves the doc empty (no noise)",
		docRows().join("").trim() === "",
	);
	check("skill: no-userMessage turn still logs the panel row", panelRows().join("\n").includes("skill: no-msg"));
}

// ─── 3. compaction: doc cleared, panel event row ──────────────────────────────

{
	toolsPanel.reset();
	responseDocBegin();
	responseIngestEntry(msgEntry("c1", "c0", { role: "user", content: "old turn" }));
	check("compaction: pre-compaction turn in the doc", docRows().join("\n").includes("old turn"));
	responseIngestEntry({
		id: "c2",
		parentId: "c1",
		type: "compaction",
		summary: "we talked about old things",
		tokensBefore: 12345,
		firstKeptEntryId: "c2",
		timestamp: new Date().toISOString(),
	});
	check("compaction: doc cleared (native parity)", docRows().length === 0);
	const panel = panelRows().join("\n");
	check("compaction: panel event row with token count", panel.includes("compaction (12345 tokens)"));
	responseIngestEntry(msgEntry("c3", "c2", { role: "user", content: "new turn" }));
	check("compaction: post-compaction turns still land in the doc", docRows().join("\n").includes("new turn"));
}

// ─── 4. branch summary + custom display messages → panel rows only ───────────

{
	toolsPanel.reset();
	responseDocBegin();
	responseIngestEntry({
		id: "b1",
		parentId: "b0",
		type: "branch_summary",
		summary: "summary of the old branch",
		fromId: "b0",
		timestamp: new Date().toISOString(),
	});
	check("branch summary: panel event row", panelRows().join("\n").includes("branch summary"));
	check("branch summary: never in the doc", docRows().length === 0);

	responseIngestEntry(
		msgEntry("b2", "b1", {
			role: "custom",
			customType: "session-title",
			content: "a title",
			display: true,
			timestamp: 1,
		}),
	);
	check("custom message: panel event row", panelRows().join("\n").includes("custom: session-title"));
	check("custom message: not in the doc", !docRows().join("\n").includes("a title"));

	const before = panelRows().length;
	responseIngestEntry(
		msgEntry("b3", "b2", {
			role: "custom",
			customType: "hidden",
			content: "no display",
			display: false,
			timestamp: 2,
		}),
	);
	check("custom message without display: dropped", panelRows().length === before);
}

// ─── 5. live bang flow: user_bash block completed by the leaf walk ────────────

{
	toolsPanel.reset();
	const entries: FakeEntry[] = [msgEntry("l0", "", { role: "user", content: "go" })];
	const ctx = fakeCtx(entries, "l0");
	responseDocBegin();
	for (const e of entries) responseIngestEntry(e);
	responseDocEnd(ctx); // parks the cursor at l0

	startLiveBash("echo hi", false);
	let rows = docRows().join("\n");
	check("live bash: running block shows the command", rows.includes("$ echo hi"));
	check("live bash: running block shows the loader", rows.includes("Running"));

	// Command completes: branch entry appended, leaf advances.
	entries.push(
		msgEntry("l1", "l0", {
			role: "bashExecution",
			command: "echo hi",
			output: "hi\n",
			exitCode: 0,
			timestamp: 3,
			excludeFromContext: false,
		}),
	);
	// fakeCtx captured the array reference; leaf id changes via a new ctx.
	const ctx2 = fakeCtx(entries, "l1");
	check("walk: ingests the new entry", syncBranchEntries(ctx2) === true);
	rows = docRows().join("\n");
	check("live bash: output arrives", rows.includes("hi"));
	check("live bash: loader gone after completion", !rows.includes("Running"));
	check("walk: second call is a no-op", syncBranchEntries(ctx2) === false);
}

// ─── 6. walk dedupe: streamed messages are never double-added ────────────────

{
	toolsPanel.reset();
	const userMsg = { role: "user", content: "hello there" };
	const entries: FakeEntry[] = [msgEntry("d0", "", { role: "user", content: "seed" })];
	const ctx = fakeCtx(entries, "d0");
	responseDocBegin();
	for (const e of entries) responseIngestEntry(e);
	responseDocEnd(ctx);

	// Live path adds the user message (message_start)…
	responseMessageStart(userMsg);
	const before = (getResponseDoc().children as any[]).length;
	// …then the walk sees the same message object appended to the branch.
	entries.push(msgEntry("d1", "d0", userMsg));
	check("dedupe: walk ingests nothing new for a streamed message", syncBranchEntries(fakeCtx(entries, "d1")) === false);
	check("dedupe: doc unchanged", (getResponseDoc().children as any[]).length === before);
}

// ─── 7. walk with cursor off the ancestry: no-op (rebuild owns it) ───────────

{
	toolsPanel.reset();
	const entriesA: FakeEntry[] = [msgEntry("x0", "", { role: "user", content: "a" })];
	const ctx = fakeCtx(entriesA, "x0");
	responseDocBegin();
	for (const e of entriesA) responseIngestEntry(e);
	responseDocEnd(ctx);

	// A different lineage (tree switch): cursor x0 not on it.
	const entriesB: FakeEntry[] = [msgEntry("y0", "", { role: "user", content: "b" })];
	const before = (getResponseDoc().children as any[]).length;
	check(
		"walk: off-ancestry leaf is a no-op",
		syncBranchEntries(fakeCtx(entriesB, "y0")) === false,
	);
	check("walk: doc untouched on off-ancestry", (getResponseDoc().children as any[]).length === before);
}

// ─── 8. toolsPanel.ingestEvent dedupe ────────────────────────────────────────

{
	toolsPanel.reset();
	toolsPanel.ingestEvent("same-id", "title", "body");
	toolsPanel.ingestEvent("same-id", "title", "body");
	const rows = panelRows().join("\n");
	check("event: deduped by id", rows.split("title").length - 1 === 1);
}

// ─── teardown: no running loaders, no doc children ───────────────────────────

resetResponseState();
check("teardown: doc cleared", (getResponseDoc().children as any[]).length === 0);
check("teardown: ResponseDoc is still the module singleton Container", getResponseDoc() instanceof Container);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
