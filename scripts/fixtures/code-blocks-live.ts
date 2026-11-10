/** Local streaming reply fixture. No network model calls or real clipboard writes. */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const fence = (language: string, text: string) => "```" + language + "\n" + text + "\n```";
export const REPLY = [
	"## Reply rendering review",
	"Language header, native syntax colors, and a subtle code frame.",
	fence("typescript", "const answer: number = 42;\n\nfunction greet(name: string): string {\n  return `Hello, ${name}`;\n}"),
	"Filename outside a language-only fence: `example.ts`.",
	fence("typescript example.ts", "const answer: number = 42;"),
	"Long lines wrap without clipping. Use `/copyblock 3` for original source.",
	fence("bash", 'printf "%s\\n" "' + "Long source line ".repeat(8).trim() + '"'),
	"Native Mermaid, without a second diagram renderer:",
	fence("mermaid", "flowchart TD\n A[Pi reply] --> B[Native renderer]\n B --> C[Terminal display]"),
	"CODEBLOCK_REVIEW_READY",
].join("\n\n");

export default function (pi: ExtensionAPI) {
	const events = process.env.SB_LIVE_EVENTS!;
	const note = (type: string, data: Record<string, unknown> = {}) => appendFileSync(events, JSON.stringify({ type, at: Date.now(), pid: process.pid, ...data }) + "\n");
	if (!(getNativeClipboard() as { __sbLiveClipboard?: boolean })?.__sbLiveClipboard) throw new Error("Clipboard safety preload is missing");
	pi.registerProvider("codeblocks-fixture", {
		api: "codeblocks-fixture-stream", apiKey: "local-fixture", baseUrl: "http://local.invalid",
		models: [{ id: "fixture", name: "Visual review fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					for (let i = 0; i < REPLY.length; i += 64) {
						const delta = REPLY.slice(i, i + 64);
						(message.content[0] as { text: string }).text += delta;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
						await delay(25, undefined, { signal: options?.signal });
					}
					stream.push({ type: "text_end", contentIndex: 0, content: REPLY, partial: message });
					stream.push({ type: "done", reason: "stop", message });
				} catch (error) {
					message.stopReason = "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: "error", error: message }); note("fixture-error", { error: String(error) });
				} finally { stream.end(); }
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => note("ready", { mode: ctx.mode, session: ctx.sessionManager.getSessionFile() }));
	pi.on("agent_settled", () => note("settled"));
	pi.on("before_agent_start", event => note("guidance", { rules: event.systemPromptOptions.promptGuidelines }));
	pi.on("session_shutdown", () => note("shutdown"));
	pi.registerCommand("visual-theme", { description: "Change the isolated review theme", handler: async (args, ctx) => {
		const result = ctx.ui.setTheme(args.trim()); if (!result.success) throw new Error(result.error); note("theme", { name: args.trim() });
	} });
}
