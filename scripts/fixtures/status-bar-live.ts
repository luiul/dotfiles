/** Deterministic local provider for the real status bar TUI tests. No network calls. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export default function (pi: ExtensionAPI) {
	const eventsPath = process.env.SB_LIVE_EVENTS!;
	const provider = process.env.SB_LIVE_PROVIDER ?? "ai-model-router";
	const note = (type: string, data: Record<string, unknown> = {}) => {
		appendFileSync(eventsPath, JSON.stringify({ type, at: Date.now(), pid: process.pid, ...data }) + "\n");
	};
	const snapshot = (ctx: ExtensionContext) => ({
		mode: ctx.mode,
		uuid: ctx.sessionManager.getSessionId(),
		leaf: ctx.sessionManager.getLeafId(),
		session: ctx.sessionManager.getSessionFile(),
		persisted: !!ctx.sessionManager.getSessionFile() && existsSync(ctx.sessionManager.getSessionFile()!),
		cwd: ctx.cwd,
		model: ctx.model?.id,
		provider: ctx.model?.provider,
		usage: ctx.getContextUsage(),
	});
	// Refuse to start if the host could reach the user's native clipboard.
	const clipboard = getNativeClipboard() as ReturnType<typeof getNativeClipboard> & { __sbLiveClipboard?: boolean };
	if (!clipboard?.__sbLiveClipboard) throw new Error("Native clipboard safety preload is not active");
	note("clipboard-safe");
	pi.registerProvider(provider, {
		api: "sb-live-stream", baseUrl: "http://local.invalid", apiKey: "local-fixture",
		models: [
			{ id: "fixture", name: "GPT-6.1 Sol", reasoning: true, input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 128000, maxTokens: 4096 },
			{ id: "unavailable", name: "GPT-6.1 Sol", reasoning: true, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 4096 },
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), content: [], stopReason: "stop",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				try {
					await options?.onPayload?.({ fixture: true }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
					const emit = async (event: Parameters<typeof stream.push>[0]) => {
						await options?.onProviderStreamEvent?.(event, model);
						stream.push(event);
					};
					note("response-start", { messages: context.messages.length });
					await emit({ type: "start", partial: message });
					await delay(1500, undefined, { signal: options?.signal });
					const text = "SB_LIVE_DONE";
					message.content.push({ type: "text", text: "" });
					await emit({ type: "text_start", contentIndex: 0, partial: message });
					message.content[0] = { type: "text", text };
					await emit({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					await emit({ type: "text_end", contentIndex: 0, content: text, partial: message });
					message.usage = { input: 30000, output: 1000, cacheRead: 40000, cacheWrite: 0, totalTokens: 71000,
						cost: { input: 0.03, output: 0.002, cacheRead: 0.004, cacheWrite: 0, total: 0.036 } };
					await emit({ type: "done", reason: "stop", message });
					stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
					stream.end();
					note("fixture-error", { error: String(error) });
				}
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => note("ready", { ...snapshot(ctx), commands: pi.getCommands().map((c) => c.name) }));
	pi.on("before_agent_start", (_event, ctx) => note("working", snapshot(ctx)));
	pi.on("agent_settled", (_event, ctx) => note("settled", snapshot(ctx)));
	pi.on("session_shutdown", () => note("shutdown"));
	pi.registerCommand("sb-live-snapshot", {
		description: "Record real host state without a model request",
		handler: async (_args, ctx) => note("snapshot", snapshot(ctx)),
	});
	pi.registerCommand("sb-live-model", {
		description: "Select a fixture with known or unavailable context limits",
		handler: async (args, ctx) => {
			const model = ctx.modelRegistry.find(provider, args.trim());
			if (!model || !await pi.setModel(model)) throw new Error("Fixture model switch failed");
			note("model", snapshot(ctx));
		},
	});
}
