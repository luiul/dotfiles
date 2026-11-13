// Run: bun scripts/test-close-status.ts. No processes, timers, files, or model requests.
import assert from "node:assert/strict";
import closeStatus, { CLOSE_GUIDANCE, parseCloseReport, restoreCloseReport } from "../pi/.pi/agent/extensions/close-status";

let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`ok ${name}`); }
const suffix = (value = "yes", reason = "Research delivered.", action = "none") => `safe_to_close: ${value}\nclose_reason: ${reason}\nnext_action: ${action}`;
const assistant = (text = suffix(), stopReason = "stop") => ({ role: "assistant", api: "fixture", provider: "fixture", model: "model", timestamp: 100, content: [{ type: "text", text }], stopReason });
const entry = (message: any, id = "a1", parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-11-12T00:00:00.000Z", message });
for (const value of ["yes", "no", "unknown"]) check(`parse ${value}`, () => assert.equal(parseCloseReport(`Reply.\n\n${suffix(value)}\n`)?.safe_to_close, value));
check("Unicode and CRLF", () => assert.equal(parseCloseReport(suffix("no", "Révision 確認.", "Review.").replaceAll("\n", "\r\n"))?.close_reason, "Révision 確認."));
for (const prefix of ["> Example", "- Example", "1. Example", "Example"]) check(`reject lazy continuation ${prefix}`, () => assert.equal(parseCloseReport(`${prefix}\n${suffix()}`), undefined));
check("blank line separates prior content", () => assert.equal(parseCloseReport(`> Example\n\n${suffix()}`)?.safe_to_close, "yes"));
const invalid = [
	"", suffix("YES"), suffix("maybe"), suffix().replace("safe_to_close:", "safe_to_close :"),
	suffix().replaceAll("\n", "\n> "), suffix().split("\n").map(l => `> ${l}`).join("\n"),
	suffix().split("\n").map(l => `    ${l}`).join("\n"), suffix().split("\n").map(l => `- ${l}`).join("\n"),
	`\`\`\`text\n${suffix()}\n\`\`\``, `\`\`\`\n${suffix()}`, `~~~text\n${suffix()}`, `   \`\`\`\n${suffix()}`,
	`${suffix()}\nMore prose.`, suffix().replace("close_reason:", "**close_reason:**"),
	`safe_to_close: no\n${suffix()}`, `${suffix()}\n${suffix()}`, suffix("yes", "x".repeat(241)),
	suffix("yes", ""), suffix("yes", " trailing "), suffix("yes", "Bad\x1b[32m"), suffix("yes", "Bad\x85"),
	suffix("yes", "Bad\u2028line"), suffix("yes", "Bad\nsecond line"), suffix().split("\n").reverse().join("\n"),
	suffix().replace("next_action: none", "next_action: none\t"),
];
invalid.forEach((text, i) => check(`reject unsafe suffix ${i}`, () => assert.equal(parseCloseReport(text), undefined)));
check("closed fenced example before actual report", () => assert.equal(parseCloseReport(`\`\`\`text\n${suffix("no")}\n\`\`\`\n\n${suffix()}`)?.safe_to_close, "yes"));
check("fence marker inside longer fence is not close", () => assert.equal(parseCloseReport(`\`\`\`\`\n\`\`\`\n${suffix()}`), undefined));

function harness(mode = "tui", hasUI = true) {
	const handlers = new Map<string, Function>(), commands = new Map<string, any>();
	const branch: any[] = [], statuses = new Map<string, string>();
	let scans = 0, writes = 0, idle = true, pending = false, serial = 0, customCalls = 0;
	const ctx: any = { mode, hasUI, isIdle: () => idle, hasPendingMessages: () => pending,
		ui: { setStatus: (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value), notify() {},
			custom: async (factory: Function) => { customCalls++; const body = factory({ terminal: { rows: 32 }, requestRender() {} }, { fg: (_: string, text: string) => text }, { matches: () => false }, () => {}); assert.ok(body.render(50).every((line: string) => line.length <= 50)); } },
		sessionManager: { getBranch: () => { scans++; return branch; }, getEntry: (id: string) => branch.find(e => e.id === id), getLeafEntry: () => branch.at(-1) } };
	closeStatus({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (name: string, def: any) => commands.set(name, def),
		appendEntry: (customType: string, data: any) => { writes++; branch.push({ type: "custom", customType, data, id: `c${++serial}`, parentId: branch.at(-1)?.id ?? null }); } } as any);
	const fire = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const start = async () => { idle = false; await fire("before_agent_start", { systemPromptOptions: { sections: {} } }); await fire("agent_start"); };
	const end = async (message = assistant(), aborted = false) => { const record = entry(message, `a${++serial}`, branch.at(-1)?.id ?? null); branch.push(record); await fire("agent_end", { messages: [message] }); idle = true; await fire("agent_settled", { aborted }); };
	return { fire, start, end, ctx, branch, statuses, handlers, commands, get scans() { return scans; }, get writes() { return writes; }, get customCalls() { return customCalls; }, set pending(value: boolean) { pending = value; } };
}
const h = harness();
await h.fire("session_start");
check("new session unknown and no persisted write", () => { assert.equal(h.statuses.get("close-status"), "Close status unknown"); assert.equal(h.writes, 0); });
await h.start();
check("working clears closing label", () => assert.equal(h.statuses.size, 0));
await h.end();
check("settled yes uses metadata, not a model message", () => { assert.equal(h.statuses.get("close-status"), "Safe to close (reported)"); assert.equal(h.writes, 1); assert.equal(h.scans, 1); assert.equal(h.branch.at(-1).type, "custom"); });
check("no actionable boundaries or stream hooks", () => { assert(!h.handlers.has("turn_end")); assert(!h.handlers.has("agent_before_settle")); assert(!h.handlers.has("message_update")); });
await h.commands.get("close-status").handler("", h.ctx);
check("command opens local report with no write or branch scan", () => { assert.equal(h.customCalls, 1); assert.equal(h.writes, 1); assert.equal(h.scans, 1); });
const validBranch = structuredClone(h.branch);
check("corrupt timestamp fails closed", () => { const records = structuredClone(validBranch); records.at(-1).data.at = 1e20; assert.equal(restoreCloseReport(records), undefined); });
check("restore yes", () => assert.equal(restoreCloseReport(validBranch)?.report?.safe_to_close, "yes"));
for (const value of ["yes", "no", "unknown"]) check(`old policy ${value} restores as unknown`, () => {
	const records = structuredClone(validBranch);
	const oldText = suffix(value, "Published; sync not checked.", "none");
	records[0].message.content[0].text = oldText;
	records.at(-1).data = { ...records.at(-1).data, version: 1, report: parseCloseReport(oldText) };
	assert.equal(restoreCloseReport(records), undefined);
});
check("later unanswered user invalidates", () => assert.equal(restoreCloseReport([...validBranch, entry({ role: "user", content: "Continue", timestamp: 101 }, "u2")]), undefined));
check("old report cannot follow newer response", () => assert.equal(restoreCloseReport([...validBranch, entry(assistant("No report"), "a2"), validBranch.at(-1)]), undefined));
check("compaction retains raw branch report", () => assert.equal(restoreCloseReport([...validBranch, { type: "compaction", id: "compact" }])?.report?.safe_to_close, "yes"));
for (const type of ["custom_message", "branch_summary", "context_edit"]) check(`${type} invalidates`, () => assert.equal(restoreCloseReport([...validBranch, { type, id: "new" }]), undefined));
check("malformed saved data fails closed", () => assert.equal(restoreCloseReport([...validBranch, { type: "custom", customType: "dotfiles.close-status", data: { version: 2, at: 100, report: { safe_to_close: "yes" }, sourceId: "a1" } }]), undefined));
await h.fire("user_bash");
check("idle bang command invalidates cached yes without persistence", () => { assert.equal(h.statuses.get("close-status"), "Close status unknown"); assert.equal(h.writes, 1); });
await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
await h.commands.get("close-status").handler("", h.ctx);
check("failed preparation never sticks at working", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
await h.fire("input");
check("new input invalidates cached yes", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
for (const stop of ["error", "aborted", "length", "pending", "toolUse", "deferred"]) {
	await h.start(); await h.end(assistant(suffix(), stop));
	check(`${stop} cannot produce green`, () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
}
await h.start(); await h.end(assistant(), true);
check("settlement abort rejects valid-looking yes", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
await h.start(); await h.end(assistant("No fields."));
check("missing fields unknown", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
await h.start(); await h.end(assistant(suffix("no", "Awaiting review.", "Review the diff.")));
check("no label", () => assert.equal(h.statuses.get("close-status"), "Not safe to close"));
await h.start(); h.pending = true; await h.end(); h.pending = false;
check("pending follow-up cannot expose yes", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
await h.start();
const intermediate = assistant(); h.branch.push(entry(intermediate, "intermediate"));
await h.fire("agent_end", { messages: [intermediate] });
check("agent_end is not final display boundary", () => assert.equal(h.statuses.size, 0));
await h.fire("agent_start"); await h.end(assistant(suffix("no", "Follow-up needs an answer.", "Answer.")));
check("retry/follow-up latest report wins", () => assert.equal(h.statuses.get("close-status"), "Not safe to close"));
await h.start(); const replaced = assistant(); h.branch.push(entry(replaced, "replaced")); await h.fire("agent_end", { messages: [replaced] });
h.branch.push({ type: "context_edit", id: "edit", parentId: "replaced" }); await h.fire("agent_settled", { aborted: false });
check("boundary context edit invalidates candidate", () => assert.equal(h.statuses.get("close-status"), "Close status unknown"));
await h.fire("session_shutdown");
check("shutdown clears only its status", () => assert.equal(h.statuses.size, 0));
for (const [mode, ui] of [["print", false], ["json", false], ["rpc", true], ["tui", false]] as const) {
	const child = harness(mode, ui); await child.fire("session_start"); await child.start(); await child.end(); await child.commands.get("close-status").handler("", child.ctx); await child.fire("session_shutdown");
	check(`${mode}/${ui} no child side effects`, () => { assert.equal(child.scans, 0); assert.equal(child.writes, 0); assert.equal(child.statuses.size, 0); assert.equal(child.customCalls, 0); });
}
check("published work awaiting live main sync is not done", () => {
	assert(CLOSE_GUIDANCE.includes("Published work is not done if the required live main checkout has not been synced to the published commit."));
	assert(CLOSE_GUIDANCE.includes("When required sync is pending, report no unless the user explicitly defers it or requests remote-only publication."));
});
check("static guidance and no dynamic model-tool schema", () => { assert(CLOSE_GUIDANCE.includes("Explicit preserved deferrals/handoffs")); assert(CLOSE_GUIDANCE.length < 1000); });
console.log(`${checks} close-status checks passed`);
