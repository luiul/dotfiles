/** Local deterministic Pi provider and API probe for test-work-completion-live.mjs. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default async function (pi: ExtensionAPI) {
	const note = (type: string, data: Record<string, unknown> = {}) => appendFileSync(process.env.WC_LIVE_EVENTS!,
		JSON.stringify({ type, pid: process.pid, at: Date.now(), ...data }) + "\n");
	let statusCommand: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const candidate = await import(process.env.WC_LIVE_EXTENSION!);
	await candidate.default(new Proxy(pi, {
		get(target, property) {
			if (property === "on") return (name: string, handler: Function) => target.on(name as any, async (event: any, ctx: any) => {
				const ui = new Proxy(ctx.ui, { get(original, key) {
					const method = Reflect.get(original, key);
					if (["notify", "setWidget", "setStatus", "confirm", "custom", "setEditorText"].includes(String(key))) return (...args: any[]) => {
						note(`ui-${String(key)}`, { mode: ctx.mode, args: args.map((a) => typeof a === "function" ? "factory" : a) });
						return method.apply(original, args);
					};
					return typeof method === "function" ? method.bind(original) : method;
				} });
				return handler(event, { ...ctx, ui });
			});
			if (property === "registerCommand") return (name: string, options: any) => {
				if (name === "work-status") statusCommand = options.handler;
				target.registerCommand(name, { ...options, handler: (args: string, ctx: ExtensionCommandContext) => {
					const ui = new Proxy(ctx.ui, { get(original, key) {
						const method = Reflect.get(original, key);
						if (key === "notify") return (...values: any[]) => {
							note("ui-notify", { mode: ctx.mode, args: values });
							return method.apply(original, values);
						};
						return typeof method === "function" ? method.bind(original) : method;
					} });
					return options.handler(args, { ...ctx, ui });
				} });
			};
			if (property === "appendEntry") return (customType: string, data: any) => {
				note("append", { customType, data });
				target.appendEntry(customType, data);
			};
			if (["sendMessage", "sendUserMessage", "registerTool"].includes(String(property))) return () => {
				note("forbidden", { property }); throw new Error(`Unexpected candidate ${String(property)}`);
			};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
	let serial = 0;
	pi.registerProvider("wc-live", {
		api: "wc-live-stream", baseUrl: "http://local.invalid", apiKey: "local-fixture",
		models: [{ id: "fixture", name: "WC Live Fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), content: [], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0,
						cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					const last = context.messages.at(-1) as any;
					const text = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
					await options?.onPayload?.({ fixture: text }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
					const emit = async (event: any) => { await options?.onProviderStreamEvent?.(event, model); stream.push(event); };
					await emit({ type: "start", partial: message });
					if (options?.signal?.aborted) throw new Error("Fixture aborted");
					const write = last?.role === "user" && text === "WC_CREATE";
					if (write) {
						message.stopReason = "toolUse";
						const call = { type: "toolCall", id: `wc-${++serial}`, name: "write", arguments: { path: join(process.cwd(), "new.txt"), content: "test change\n" } };
						message.content.push(call);
						await emit({ type: "toolcall_start", contentIndex: 0, partial: message });
						await emit({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
					} else {
						message.content.push({ type: "text", text: "WC_DONE" });
						await emit({ type: "text_start", contentIndex: 0, partial: message });
						await emit({ type: "text_delta", contentIndex: 0, delta: "WC_DONE", partial: message });
						await emit({ type: "text_end", contentIndex: 0, content: "WC_DONE", partial: message });
					}
					note("response", { write, prompt: text });
					await emit({ type: "done", reason: message.stopReason, message }); stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
					note("fixture-error", { error: String(error) });
				}
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => note("ready", { mode: ctx.mode, session: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(), commands: pi.getCommands().map((c) => c.name) }));
	pi.on("agent_settled", (event, ctx) => note("settled", { aborted: event.aborted, session: ctx.sessionManager.getSessionFile() }));
	pi.on("session_shutdown", () => note("shutdown"));
	pi.registerCommand("wc-live-draft", {
		description: "Probe work status with an existing draft",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("DRAFT keep this text");
			await statusCommand!("", ctx);
			note("draft-after", { text: ctx.ui.getEditorText() });
		},
	});
}
