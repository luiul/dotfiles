/** Local cancellation fixture. All I/O stays in the test's private directory. */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export default function (pi: ExtensionAPI) {
	const events = process.env.EXIT_LIVE_EVENTS!;
	const scenario = process.env.EXIT_LIVE_SCENARIO!;
	const note = (type: string, data: Record<string, unknown> = {}) => appendFileSync(events, JSON.stringify({ type, at: Date.now(), pid: process.pid, ...data }) + "\n");
	let calls = 0;
	pi.registerProvider("exit-fixture", {
		api: "exit-fixture-stream", apiKey: "fixture", baseUrl: "http://fixture.invalid",
		models: [{ id: "fixture", name: "Exit fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const call = ++calls;
			const child = JSON.stringify(_context.messages).includes("EXIT_CHILD_ONLY");
			queueMicrotask(async () => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					stream.push({ type: "start", partial: message });
					note("request", { call, child });
					if ((scenario === "tool" || scenario === "context") && call === 1) {
						const command = `echo $$ > '${process.env.EXIT_LIVE_WORKER_PID}'; exec /bin/sleep 60`;
						const tool = { type: "toolCall" as const, id: "exit-call", name: scenario === "context" ? "exit_context_probe" : "bash", arguments: scenario === "context" ? {} : { command, timeout: 60 } };
						message.content.push(tool);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: message });
						message.stopReason = "toolUse";
					} else if (scenario === "retry") {
						message.stopReason = "error"; message.errorMessage = "503 service unavailable, fixture retry";
						stream.push({ type: "error", reason: "error", error: message });
						return;
					} else {
						message.content.push({ type: "text", text: "EXIT_STREAM_READY" });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "EXIT_STREAM_READY", partial: message });
						if (scenario !== "compaction") await delay(60_000, undefined, { signal: options?.signal });
						stream.push({ type: "text_end", contentIndex: 0, content: "EXIT_STREAM_READY", partial: message });
					}
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
					note("cancelled", { call, child });
				} finally { stream.end(); }
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => note("ready", { session: ctx.sessionManager.getSessionFile(), mode: ctx.mode }));
	pi.on("agent_settled", event => note("settled", { aborted: event.aborted }));
	pi.on("session_before_compact", async event => {
		if (scenario !== "compaction") return;
		note("compaction");
		try { await delay(60_000, undefined, { signal: event.signal }); }
		catch { note("compaction-cancelled"); }
		return { cancel: true };
	});
	pi.on("session_shutdown", async (event, ctx) => {
		note("shutdown", { reason: event.reason, mode: ctx.mode });
		// Prove Pi awaits async cleanup, rather than only starting its handlers.
		await delay(40);
		note("cleanup-complete", { mode: ctx.mode });
	});
	pi.events.on("subagents:disposed", () => note("subagents-disposed"));
	pi.registerCommand("exit-child-start", { description: "Start the private cleanup fixture", handler: async (_args, ctx) => {
		const requestId = "exit-fixture-child";
		const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, reply => { unsub(); note("child-spawn", reply as Record<string, unknown>); });
		pi.events.emit("subagents:rpc:spawn", { requestId, type: "exit-child", prompt: "EXIT_CHILD_ONLY", options: { description: "Exit fixture child", isBackground: true, model: ctx.model } });
	} });
	pi.registerTool({
		name: "exit_context_probe", label: "Exit cleanup probe", description: "Run the isolated context-mode worker", parameters: { type: "object", properties: {} },
		async execute(_id, _input, _signal, _onUpdate, ctx) {
			note("context-call");
			const outcome = await ctx.executeTool("ctx_execute", { language: "shell", code: `echo $$ > '${process.env.EXIT_LIVE_WORKER_PID}'; exec /bin/sleep 60`, timeout: 60_000 });
			note("context-result", { isError: outcome.isError });
			return outcome.result;
		},
	});
}
