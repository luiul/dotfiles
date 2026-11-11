/** Local provider, native tools and passive render probes for test-zen-live.mjs. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { ProcessTerminal, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export default async function (pi: ExtensionAPI) {
	// hrtime is a monotonic clock shared by the fixture and its supervising process.
	const note = (type: string, data: Record<string, unknown> = {}) => appendFileSync(process.env.ZEN_LIVE_EVENTS!,
		JSON.stringify({ type, pid: process.pid, mono: Number(process.hrtime.bigint()) / 1e6, elapsed: performance.now(), ...data }) + "\n");
	const componentPath = process.env.ZEN_LIVE_TOOL_COMPONENT!;
	const packageRoot = join(dirname(componentPath), "../../../..");
	assert.equal(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, "1.5.1");
	const { ToolExecutionComponent } = await import(pathToFileURL(componentPath).href);
	const proto = ToolExecutionComponent.prototype;
	for (const method of ["render", "updateResult", "updateArgs", "setArgsComplete", "markExecutionStarted", "setExpanded"])
		assert.equal(typeof proto[method], "function", `Missing Pi 1.5.1 component method: ${method}`);
	assert.equal(typeof ProcessTerminal.prototype.write, "function", "Missing terminal write probe");
	const originalRender = proto.render, originalResult = proto.updateResult, originalComplete = proto.setArgsComplete,
		originalWrite = ProcessTerminal.prototype.write;
	const previousFrames = new WeakMap<object, string>();
	const validate = (component: any) => {
		try {
			assert(component instanceof ToolExecutionComponent, "Probe must observe an actual host component");
			assert.equal(typeof component.toolCallId, "string");
			assert.equal(typeof component.toolName, "string");
			for (const field of ["expanded", "isPartial", "executionStarted", "argsComplete"])
				assert.equal(typeof component[field], "boolean", `Missing component state: ${field}`);
			assert(component.args && typeof component.args === "object", "Missing actual argument state");
		} catch (error) { note("fixture-error", { error: String(error) }); throw error; }
	};
	note("instrumentation", { version: "1.5.1", componentPath });
	// Instrument actual host components, not a second component simulation. Never trigger a paint here.
	proto.render = function (width: number) {
		const lines = originalRender.call(this, width);
		validate(this);
		const frame = { id: this.toolCallId, tool: this.toolName, width, expanded: this.expanded,
			partial: this.isPartial, started: this.executionStarted, argsComplete: this.argsComplete,
			args: this.args, error: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			lines: lines.map((line: string) => stripTerminalSequences(line)), ansi: lines };
		const signature = JSON.stringify(frame);
		if (previousFrames.get(this) !== signature) { previousFrames.set(this, signature); note("frame", frame); }
		return lines;
	};
	proto.updateResult = function (result: any, partial: boolean = false) {
		validate(this);
		note("component-result", { id: this.toolCallId, partial, error: result.isError, durationMs: result.durationMs });
		return originalResult.call(this, result, partial);
	};
	proto.setArgsComplete = function () {
		validate(this);
		// Pi 1.5.1 marks completion at assistant message_end, not the full-value delta.
		// Observe the native transition only. Do not invoke render or invalidate.
		note("args-complete", { id: this.toolCallId, args: this.args });
		return originalComplete.call(this);
	};
	ProcessTerminal.prototype.write = function (data: string) {
		// Count real calls to terminal.write. PI_TUI_WRITE_LOG itself is a byte log, not a write counter.
		note("write", { bytes: Buffer.byteLength(data), data });
		return originalWrite.call(this, data);
	};
	const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("fixture aborted")); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	});
	const execute = async (id: string, params: any, signal: AbortSignal | undefined, onUpdate: any) => {
		note("execute", { id, name: params.name });
		const hold = params.name === "INTERACT" ? 800 : params.name === "ABORT" ? 1200 : 300;
		for (const marker of ["ONE", "TWO", "THREE"]) {
			onUpdate?.({ content: [{ type: "text", text: `ZEN_PARTIAL_SECRET_${marker}\nsecond live output line` }], details: { marker } });
			note("partial", { id, marker });
			await pause(hold, signal);
		}
		if (params.name === "FAIL") throw new Error("fixture failure");
		return { content: [{ type: "text" as const, text: "ZEN_FINAL_SECRET_OK\nsecond final output line" }], details: {} };
	};
	pi.registerTool({
		name: "zen_native", label: "Zen native", description: "Local native-rendered streaming fixture",
		parameters: Type.Object({ name: Type.String() }), execute,
		renderCall(args, _theme, ctx) {
			note("native-call", { id: ctx.toolCallId, expanded: ctx.expanded, partial: ctx.isPartial });
			const text = ctx.lastComponent ?? new Text("", 0, 0);
			text.setText(`NATIVE_CALL ${args?.name ?? "pending"}\nnative second call line`);
			return text;
		},
		renderResult(result, options, _theme, ctx) {
			note("native-result", { id: ctx.toolCallId, expanded: options.expanded, partial: options.isPartial });
			const text = ctx.lastComponent ?? new Text("", 0, 0);
			text.setText(`NATIVE_RESULT\n${result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n")}`);
			return text;
		},
	});
	pi.registerTool({ name: "zen_generic", label: "Zen generic", description: "Local generic streaming fixture",
		parameters: Type.Object({ name: Type.String() }), execute });

	const candidate = await import(process.env.ZEN_LIVE_EXTENSION!);
	if (typeof candidate.__setConfigPathForTest !== "function") throw new Error("Zen must expose its isolated config test seam");
	candidate.__setConfigPathForTest(process.env.ZEN_LIVE_CONFIG!);
	await candidate.default(new Proxy(pi, {
		get(target, key) {
			if (key === "registerCommand") return (name: string, options: any) => target.registerCommand(name, {
				...options, handler: async (...args: any[]) => { await options.handler(...args); note("command", { name, args: args[0] }); },
			});
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
	let serial = 0;
	pi.registerProvider("zen-live", {
		api: "zen-live-stream", baseUrl: "http://local.invalid", apiKey: "local-fixture",
		models: [{ id: "fixture", name: "Zen Live Fixture", reasoning: false, input: ["text"],
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
					note("request", { prompt: last?.role === "user" ? text : "followup" });
					await options?.onPayload?.({ fixture: text }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
					const emit = async (event: any) => { await options?.onProviderStreamEvent?.(event, model); stream.push(event); };
					await emit({ type: "start", partial: message });
					if (last?.role === "user") {
						const scenario = text.replace(/^ZEN_/, "");
						const name = scenario.startsWith("BASH") ? "bash" : scenario === "READ" ? "read" : scenario === "GENERIC" ? "zen_generic" : "zen_native";
						const args = name === "bash" ? { command: `/bin/bash ./shell-${scenario === "BASH_ABORT" ? "abort" : scenario === "BASH_INTERACT" ? "interact" : "case"}.sh`, timeout: 10 } :
							name === "read" ? { path: "read-case.txt", offset: 1, limit: 2 } : { name: scenario };
						const call = { type: "toolCall", id: `zen-${++serial}`, name, arguments: {} };
						message.content.push(call); message.stopReason = "toolUse";
						note("call-start", { id: call.id, tool: name, scenario, args: call.arguments });
						await emit({ type: "toolcall_start", contentIndex: 0, partial: message });
						await pause(150, options?.signal);
						call.arguments = name === "bash" ? { command: "/bin/bash" } : name === "read" ? { path: "read" } : { name: scenario.slice(0, 2) };
						await emit({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments).slice(0, -1), partial: message });
						note("args-progress", { id: call.id, args: call.arguments });
						await pause(150, options?.signal);
						call.arguments = args;
						await emit({ type: "toolcall_delta", contentIndex: 0, delta: "}", partial: message });
						note("args-full", { id: call.id, args: call.arguments });
						await pause(150, options?.signal);
						await emit({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
						note("call-end", { id: call.id });
					} else {
						// Keep the next model turn quiet so another message cannot conceal a missing completion paint.
						await pause(350, options?.signal);
						message.content.push({ type: "text", text: "ZEN_DONE" });
						await emit({ type: "text_start", contentIndex: 0, partial: message });
						await emit({ type: "text_delta", contentIndex: 0, delta: "ZEN_DONE", partial: message });
						await emit({ type: "text_end", contentIndex: 0, content: "ZEN_DONE", partial: message });
					}
					await emit({ type: "done", reason: message.stopReason, message }); stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
					note(message.stopReason === "aborted" ? "stream-aborted" : "fixture-error", { error: String(error) });
				}
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => note("ready", { mode: ctx.mode, session: ctx.sessionManager.getSessionFile() }));
	pi.on("tool_execution_start", (event) => note("tool-start", { id: event.toolCallId, tool: event.toolName }));
	pi.on("tool_execution_end", (event) => note("tool-end", { id: event.toolCallId, error: event.isError, durationMs: event.durationMs }));
	pi.on("agent_settled", (event) => note("settled", { aborted: event.aborted }));
	pi.on("session_shutdown", () => {
		note("shutdown");
		proto.render = originalRender; proto.updateResult = originalResult; proto.setArgsComplete = originalComplete;
		ProcessTerminal.prototype.write = originalWrite;
	});
}
