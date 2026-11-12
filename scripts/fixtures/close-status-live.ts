/** Local response fixture for closing-safety checks. No model network calls. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export default function fixture(pi: ExtensionAPI) {
	const log = (type: string, data = {}) => appendFileSync(process.env.CLOSE_LIVE_EVENTS!, JSON.stringify({ type, pid: process.pid, ...data }) + "\n");
	const snapshot = (ctx: any) => ({ uuid: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), leaf: ctx.sessionManager.getLeafId(), commands: pi.getCommands().map(c => c.name) });
	let source: string | undefined;
	let priorLeaf: string | undefined;
	let continueOnce = false;
	let toolOnce = false;
	let calls = 0;
	pi.registerProvider("close-live", {
		api: "close-live-stream", baseUrl: "http://local.invalid", apiKey: "fixture",
		models: [{ id: "fixture", name: "Close Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model, context, options) {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				const last = context.messages.findLast(m => m.role === "user");
				const prompt = typeof last?.content === "string" ? last.content : last?.content?.filter(p => p.type === "text").map(p => p.text).join(" ") ?? "";
				log("model-call", { calls, prompt, guided: context.messages.some(m => m.role === "system" && JSON.stringify(m).includes("safe_to_close:")) });
				try {
					stream.push({ type: "start", partial: message });
					await delay(prompt.includes("slow") ? 4000 : 120, undefined, { signal: options?.signal });
					if (prompt === "tool" && !toolOnce) {
						toolOnce = true;
						message.content = [{ type: "toolCall", id: "fixture-call", name: "close_live_tool", arguments: {} }];
						message.stopReason = "toolUse";
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
						stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
					}
					const value = /^(no|approval|publication|background)$/.test(prompt) || prompt.includes("pending review") || prompt === "continue" && continueOnce ? "no" : "yes";
					const reason = value === "no" ? "Review and publication approval remain." : "Research delivered or work explicitly deferred.";
					let text = `CLOSE_REPLY_${calls}\n\nsafe_to_close: ${value}\nclose_reason: ${reason}\nnext_action: ${value === "no" ? "Review the diff." : "none"}`;
					if (prompt === "missing") text = "CLOSE_MISSING_FIELDS";
					if (prompt === "quoted") text = `\`\`\`text\n${text}\n\`\`\``;
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					message.content[0] = { type: "text", text };
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
					if (prompt === "error") { message.stopReason = "error"; message.errorMessage = "Fixture failure"; stream.push({ type: "error", reason: "error", error: message }); }
					else { message.stopReason = prompt === "length" ? "length" : "stop"; stream.push({ type: "done", reason: message.stopReason, message }); }
					stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
				}
			});
			return stream;
		},
	});
	pi.registerTool({ name: "close_live_tool", label: "Fixture tool", description: "Local fixture", parameters: { type: "object", properties: {} }, async execute() { log("tool"); return { content: [{ type: "text", text: "Local tool complete" }], details: {} }; } });
	pi.on("session_start", (_event, ctx) => log("ready", snapshot(ctx)));
	pi.on("before_agent_start", (_event, ctx) => { priorLeaf = ctx.sessionManager.getLeafId() ?? undefined; log("working"); });
	pi.on("agent_settled", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const report = branch.findLast(e => e.type === "custom" && e.customType === "dotfiles.close-status");
		source = report?.parentId ?? undefined;
		log("settled", { ...snapshot(ctx), report: report?.type === "custom" ? report.data : undefined });
	});
	pi.on("agent_before_settle", (event) => {
		if (event.context.contextMessages.some(m => m.role === "user" && (typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join(" ")) === "continue") && !continueOnce) { continueOnce = true; return { entries: [...event.entries, { type: "custom_message", customType: "fixture-continue", content: "Finish the pending review before closing.", display: false }], continue: true }; }
	});
	pi.on("session_before_compact", () => ({ compaction: { summary: "Fixture summary.", firstKeptEntryId: source!, tokensBefore: 0 } }));
	pi.on("session_shutdown", () => log("shutdown"));
	pi.registerCommand("close-live-tree", { description: "Fixture branch navigation", handler: async (args, ctx) => {
		const target = args.trim() === "previous" ? priorLeaf : source;
		if (!target) throw new Error("No fixture branch target");
		await ctx.navigateTree(target, { summarize: false }); log("tree", { target });
	} });
	pi.registerCommand("close-live-clone", { description: "Fixture branch clone", handler: async (_args, ctx) => {
		const leaf = ctx.sessionManager.getLeafId();
		if (!leaf) throw new Error("Missing clone target");
		await ctx.fork(leaf, { position: "at" });
	} });
	pi.registerCommand("close-live-resume", { description: "Fixture resume", handler: async (args, ctx) => { await ctx.switchSession(args.trim()); } });
	pi.registerCommand("close-live-snapshot", { description: "Fixture snapshot", handler: async (_args, ctx) => log("snapshot", snapshot(ctx)) });
}
