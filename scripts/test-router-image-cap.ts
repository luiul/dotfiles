// Mock-harness test for the router-image-cap pi extension.
// Drives the real extension file with a stubbed ExtensionAPI, firing the
// `context` event with synthetic transcripts and asserting: cap math (keep the
// N most recent images), placeholder content and source paths, provider
// scoping, transcript immutability, notify dedupe, and the PI_IMAGE_CAP_MAX
// override.
//
// Run: bun scripts/test-router-image-cap.ts
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = "../pi/.pi/agent/extensions/router-image-cap.ts";

// --- fixtures ------------------------------------------------------------------
let imgSeq = 0;
const img = () => ({ type: "image", data: `img-${++imgSeq}`, mimeType: "image/png" });
const imgN = (n: number) => ({ type: "image", data: `img-${n}`, mimeType: "image/png" });
const txt = (t: string) => ({ type: "text", text: t });

const userMsg = (...content: unknown[]) => ({
	role: "user",
	content: content.length ? content : [txt("hi")],
	timestamp: 1,
});
const assistantCall = (id: string, path: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
	api: "openai-completions",
	provider: "ai-model-router",
	model: "zai-org/GLM-5.3",
	timestamp: 2,
});
const toolResult = (id: string, ...content: unknown[]) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content,
	isError: false,
	timestamp: 3,
});

// 11 images: user(A,B) -> read -> C -> user(D,E,F) -> read -> G -> user(H,I,J,K)
// Oldest three (A, B, C) must be dropped; D..K (8) stay.
const transcript = () => [
	userMsg(imgN(1), imgN(2)),
	assistantCall("call-1", "/tmp/a.png"),
	toolResult("call-1", txt("file content"), imgN(3)),
	userMsg(imgN(4), imgN(5), imgN(6)),
	assistantCall("call-2", "/tmp/b.png"),
	toolResult("call-2", imgN(7)),
	userMsg(txt("look at these"), imgN(8), imgN(9), imgN(10), imgN(11)),
];

const countImages = (parts: unknown[]) => parts.filter((p: any) => p?.type === "image").length;
const placeholders = (parts: unknown[]) =>
	parts.filter((p: any) => p?.type === "text" && String(p.text).includes("[Image omitted:"));

// --- stub ExtensionAPI -----------------------------------------------------------
class MockPi {
	handlers: Record<string, Function[]> = {}
	commands: Record<string, Function> = {}
	on(event: string, fn: Function) {
		;(this.handlers[event] ??= []).push(fn)
	}
	registerCommand(name: string, opts: any) {
		this.commands[name] = opts.handler
	}
	async fire(event: string, messages: unknown[], provider?: string) {
		const notes: string[] = []
		const notify = (msg: string, level: string) => notes.push(`${level}:${msg}`)
		const ctx = {
			model: provider === undefined ? undefined : { provider },
			ui: { notify },
			hasUI: true,
		}
		let result: any
		for (const fn of this.handlers[event] ?? []) result = await fn({ type: event, messages }, ctx)
		return { result, notes }
	}
}

let failures = 0;
function check(name: string, cond: boolean) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

// --- scenarios (default cap 8) ----------------------------------------------------
const { default: ext } = await import(EXT);
{
	const pi = new MockPi();
	await ext(pi as any);
	check("context handler registered", (pi.handlers["context"] ?? []).length === 1);
	check("/image-cap command registered", typeof pi.commands["image-cap"] === "function");

	// Under the cap: untouched, no notify.
	let { result, notes } = await pi.fire("context", transcript().slice(0, 5), "ai-model-router");
	check("under cap returns nothing", result === undefined);
	check("under cap no notify", notes.length === 0);

	// Unscoped provider: untouched.
	({ result, notes } = await pi.fire("context", transcript(), "amazon-bedrock"));
	check("bedrock provider untouched", result === undefined && notes.length === 0);

	// No model at all: untouched.
	({ result } = await pi.fire("context", transcript(), undefined));
	check("missing model untouched", result === undefined);

	// 11 images on the router: drop exactly the 3 oldest.
	const original = transcript();
	({ result, notes } = await pi.fire("context", original, "ai-model-router"));
	check("over cap returns new messages", Array.isArray(result?.messages));
	const out = result.messages as any[];
	check("message count unchanged", out.length === original.length);
	check("3 placeholders inserted", out.reduce((n: number, m: any) => n + (Array.isArray(m.content) ? placeholders(m.content).length : 0), 0) === 3);
	check("8 images kept", out.reduce((n: number, m: any) => n + (Array.isArray(m.content) ? countImages(m.content) : 0), 0) === 8);
	check("first user message fully placeholdered", placeholders(out[0].content).length === 2 && countImages(out[0].content) === 0);
	check(
		"toolResult image placeholder names the source path",
		placeholders(out[2].content).length === 1 && String(out[2].content.find((p: any) => p?.type === "text" && p.text.includes("[Image omitted:")).text).includes("/tmp/a.png"),
	);
	check("kept images are the newest (D..K)", out[6].content.filter((p: any) => p?.type === "image").map((p: any) => p.data).join(",") === "img-8,img-9,img-10,img-11");
	check("assistant toolCall content preserved", JSON.stringify(out[1].content) === JSON.stringify(original[1].content));
	check("original transcript not mutated", original[0].content.every((p: any) => p.type !== "text" || !p.text.includes("[Image omitted:")));
	check("original still has 11 images", original.reduce((n: number, m: any) => n + (Array.isArray(m.content) ? countImages(m.content) : 0), 0) === 11);
	check("placeholder explains the cap", String(out[0].content[0].text).includes("max 8 images"));
	check("user-message placeholder is generic", placeholders(out[0].content).every((p: any) => p.text.includes("an attached user image")));
	check("notify fired once for a new drop count", notes.filter((n) => n.includes("dropped the 3 oldest")).length === 1);
	check("notify mentions the transcript keeps them", notes.some((n) => n.includes("transcript keeps all of them")));

	// Same request again: trimmed identically, but no repeat notify.
	({ result, notes } = await pi.fire("context", transcript(), "ai-model-router"));
	check("same drop count does not re-notify", notes.length === 0 && result?.messages?.length === 7);

	// Exactly at the cap (8 images): untouched.
	const atCap = [userMsg(imgN(1), imgN(2), imgN(3), imgN(4)), userMsg(imgN(5), imgN(6), imgN(7), imgN(8))];
	({ result, notes } = await pi.fire("context", atCap, "ai-model-router"));
	check("exactly 8 images untouched", result === undefined && notes.length === 0);

	// /image-cap command output for scoped and unscoped providers.
	const notesCmd: string[] = [];
	const notify = (msg: string, level: string) => notesCmd.push(`${level}:${msg}`);
	await pi.commands["image-cap"]("", { model: { provider: "ai-model-router" }, ui: { notify } });
	await pi.commands["image-cap"]("", { model: { provider: "amazon-bedrock" }, ui: { notify } });
	check("/image-cap scoped shows the cap", notesCmd.some((n) => n.includes("Image cap: 8 per request") && n.includes("ai-model-router")));
	check("/image-cap unscoped says inactive", notesCmd.some((n) => n.includes("inactive") && n.includes("amazon-bedrock")));

	// String content (non-array) must not break the walker.
	({ result } = await pi.fire("context", [{ role: "user", content: "plain", timestamp: 1 }, ...transcript()], "ai-model-router"));
	check("string content passes through", result?.messages?.[0]?.content === "plain" && placeholders(result.messages[1].content).length === 2);
}

// --- PI_IMAGE_CAP_MAX override ----------------------------------------------------
process.env.PI_IMAGE_CAP_MAX = "2";
{
	const { default: ext2 } = await import(`${EXT}?cap=2`);
	const pi = new MockPi();
	await ext2(pi as any);
	const { result, notes } = await pi.fire("context", [userMsg(img(), img(), img())], "ai-model-router");
	const out = result.messages as any[];
	check("override cap=2 keeps the 2 newest", countImages(out[0].content) === 2 && placeholders(out[0].content).length === 1);
	check("override placeholder cites the cap", String(placeholders(out[0].content)[0].text).includes("max 2 images"));
	check("override notifies", notes.some((n) => n.includes("dropped the 1 oldest image ")));
}
delete process.env.PI_IMAGE_CAP_MAX;

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
