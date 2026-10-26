/** Local deterministic provider and public command probe for test-filechanges-live.mjs. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default async function (pi: ExtensionAPI) {
	const eventsPath = process.env.FC_LIVE_EVENTS!;
	const note = (type: string, data: Record<string, unknown> = {}) => {
		appendFileSync(eventsPath, JSON.stringify({ type, at: Date.now(), pid: process.pid, ...data }) + "\n");
	};
	// getCommands() exposes SlashCommandInfo, not handlers. Capture registration through a
	// forwarding API wrapper instead. The production command and UI run unchanged.
	let openList: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const source = process.env.FC_LIVE_EXTENSION;
	if (source) {
		const extension = await import(source);
		const api = new Proxy(pi, {
			get(target, key) {
				if (key === "registerCommand") return (name: string, options: any) => {
					if (name === "filechanges") openList = options.handler;
					target.registerCommand(name, options);
				};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await extension.default(api);
	}
	let serial = 0;
	pi.registerProvider("fc-live", {
		api: "fc-live-stream", baseUrl: "http://local.invalid", apiKey: "local-fixture",
		models: [{ id: "fixture", name: "FC Live Fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), content: [], stopReason: "stop",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					const last = context.messages.at(-1) as any;
					const text = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : String(last?.content ?? "");
					await options?.onPayload?.({ fixture: text }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
					const emit = async (event: any) => {
						await options?.onProviderStreamEvent?.(event, model);
						stream.push(event);
					};
					if (options?.signal?.aborted) throw new Error("Fixture aborted");
					await emit({ type: "start", partial: message });
					const files = last?.role === "user" && text === "FC_CREATE" ? ["alpha.txt", "beta.txt"] :
						last?.role === "user" && text === "FC_MUTATE" ? ["alpha.txt"] : [];
					if (files.length) {
						message.stopReason = "toolUse";
						for (const name of files) {
							const index = message.content.length;
							const call = { type: "toolCall", id: `fc-${process.pid}-${++serial}`, name: "write",
								arguments: { path: join(process.cwd(), name), content: text === "FC_MUTATE" ? "alpha\nchanged\n" : name + "\n" } };
							message.content.push(call);
							await emit({ type: "toolcall_start", contentIndex: index, partial: message });
							await emit({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
						}
					} else {
						message.content.push({ type: "text", text: "FC_DONE" });
						await emit({ type: "text_start", contentIndex: 0, partial: message });
						await emit({ type: "text_delta", contentIndex: 0, delta: "FC_DONE", partial: message });
						await emit({ type: "text_end", contentIndex: 0, content: "FC_DONE", partial: message });
					}
					note("response", { prompt: text, tools: files });
					await emit({ type: "done", reason: message.stopReason, message });
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
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.onTerminalInput((data) => {
			if (/\x1b\[.*[~FH]$/.test(data)) note("navigation", { data });
			return undefined;
		});
		note("ready", { mode: ctx.mode, session: ctx.sessionManager.getSessionFile(), commands: pi.getCommands().map((c) => c.name) });
	});
	pi.on("agent_settled", (_event, ctx) => note("settled", { session: ctx.sessionManager.getSessionFile() }));
	pi.on("session_shutdown", () => note("shutdown"));
	pi.registerCommand("fc-live-draft", {
		description: "Probe the real List with an existing draft",
		handler: async (_args, ctx) => {
			if (!openList) throw new Error("filechanges command not captured");
			ctx.ui.setEditorText("DRAFT keep this text");
			note("draft-before", { text: ctx.ui.getEditorText() });
			await openList("", ctx);
			note("draft-after", { text: ctx.ui.getEditorText() });
		},
	});
	pi.registerCommand("fc-live-theme", {
		description: "Switch the isolated host theme",
		handler: async (args, ctx) => note("theme", { name: args, ...ctx.ui.setTheme(args) }),
	});
}
