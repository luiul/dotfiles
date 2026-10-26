// Regression tests against Pi's actual tool components and renderers.
// Run: bun scripts/test-zen-components.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zen, { makeResolver, __setConfigPathForTest } from "../pi/.pi/agent/extensions/zen.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "zen-components-"));
__setConfigPathForTest(join(temp, "zen.json"));

const release = realpathSync(join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist"));
const load = (path: string) => import(pathToFileURL(join(release, path)).href);
const themes = await load("modes/interactive/theme/theme.js");
themes.initTheme("dark");
const { theme } = themes;
const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js");
const { createShellRenderers } = await load("core/tools/renderers/bash.js");
const { readRenderers } = await load("core/tools/renderers/read.js");
const { Text, visibleWidth } = await import("@earendil-works/pi-tui");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
	console.log(`${condition ? "ok" : "FAIL"} ${name}`);
	condition ? pass++ : fail++;
}
const events: Record<string, Function> = {};
const commands: Record<string, any> = {};
zen({ registerFlag() {}, registerShortcut() {}, registerToolRenderer() {},
	registerCommand(name: string, def: any) { commands[name] = def; },
	on(name: string, fn: Function) { events[name] = fn; }, getFlag(name: string) { return name === "zen"; },
} as any);
const resolver = makeResolver(() => true);
const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], details: {}, isError, durationMs: 421 });
const component = (tool: string, args: any, renderers: any, requestRender = () => {}) =>
	new ToolExecutionComponent(tool, "fixture", args, { showImages: false, outputPad: 1 }, renderers, { requestRender }, "/tmp/zen-components");

try {
	for (const tool of ["bash", "powershell", "read", "custom", "registered", "unknown"]) {
		for (const width of [36, 80, 120]) {
			events.session_start({}, {});
			let redraws = 0, calls = 0, results = 0;
			const native = tool === "bash" || tool === "powershell" ? createShellRenderers(tool === "bash" ? "$" : "PS>") :
				tool === "read" ? readRenderers : tool === "registered" ? {} : tool === "unknown" ? undefined : {
					renderCall() { calls++; return new Text("native\ncall", 0, 0); },
					renderResult() { results++; return new Text("native\npartial", 0, 0); },
				};
			const c = component(tool, {}, resolver(tool, () => native), () => redraws++);
			const compact = (stage: string) => check(`${tool} ${width} ${stage} stays two physical rows`, c.render(width).length === 2);
			compact("empty arguments");
			c.updateArgs({ command: "echo fixture", path: "/tmp/zen-components/fixture.txt", query: "fixture" });
			compact("argument update");
			c.setArgsComplete(); c.markExecutionStarted(); compact("execution start");
			c.updateResult(result("hidden\npartial"), true); compact("partial result");
			check(`${tool} ${width} collapsed preview hidden`, !c.render(width).join("\n").includes("hidden"));
			check(`${tool} ${width} skips hidden native rendering`, calls === 0 && results === 0);
			const before = redraws;
			c.updateResult(result("fixture failed", true), false);
			compact("failure");
			check(`${tool} ${width} first final paint includes status`, c.render(width).join("\n").includes("✗"));
			await wait(5);
			check(`${tool} ${width} final status adds no redraw`, redraws === before);
			check(`${tool} ${width} collapsed shell has no timer`, !c.rendererState.interval);
		}
	}

	for (const exit of ["success", "error", "abort"]) {
		events.session_start({}, {});
		let redraws = 0;
		const c = component("bash", { command: "echo fixture" }, resolver("bash", () => createShellRenderers("$")), () => redraws++);
		c.setArgsComplete(); c.markExecutionStarted();
		c.updateResult(result("running preview"), true);
		c.setExpanded(true);
		check(`${exit}: expansion shows running output`, c.render(80).join("\n").includes("running preview"));
		check(`${exit}: expanded native timer starts`, !!c.rendererState.interval);
		c.setExpanded(false);
		check(`${exit}: collapse hides live output`, c.render(80).length === 2);
		const before = redraws;
		await wait(1100);
		check(`${exit}: hidden native timer cannot request paints`, redraws === before);
		c.updateResult(result(exit === "abort" ? "Aborted" : exit, exit !== "success"), false);
		check(`${exit}: native timer released at completion`, !c.rendererState.interval);
		check(`${exit}: final status present immediately`, c.render(80).join("\n").includes(exit === "success" ? "✓" : "✗"));
	}

	{
		events.session_start({}, {});
		const c = component("read", { path: "fixture.txt" }, resolver("read", () => readRenderers));
		c.render(80);
		c.updateResult({ ...result("done"), details: { truncation: { truncated: true } } }, false);
		check("first completion paint includes truncation warning", c.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n").includes("✓ truncated"));
		c.updateResult(result("done"), false);
		check("changed metadata clears warning without another pass", !c.render(80).join("\n").includes("truncated"));
	}

	{
		let cleanup = 0;
		const native = {
			renderCall() { return new Text("call resource", 0, 0); },
			renderResult() { cleanup++; return new Text("released", 0, 0); },
		};
		const c = component("resource", {}, resolver("resource", () => native));
		c.setExpanded(true);
		c.setExpanded(false);
		c.updateResult(result("Aborted", true), false);
		check("native call-only partial lifecycle gets final cleanup", cleanup === 1);
	}

	for (const self of [false, true]) {
		let lastPartial: any, cleanups = 0;
		const native = {
			...(self ? { renderShell: "self" } : {}),
			renderCall() { return new Text("custom call", 0, 0); },
			renderResult(r: any, options: any, _theme: any, ctx: any) {
				if (options.isPartial) return lastPartial = new Text("custom running", 0, 0);
				if (ctx.lastComponent === lastPartial) cleanups++;
				return new Text(`detail ${r.details?.label}`, 0, 0);
			},
		};
		events.session_start({}, {});
		const c = component("custom", {}, resolver("custom", () => native));
		c.updateResult(result("running"), true);
		await commands.zen.handler("off", { ui: { notify() {} } });
		check(`custom ${self} Zen off shows partial details`, c.render(80).join("\n").includes("custom running"));
		await commands.zen.handler("on", { ui: { notify() {} } });
		check(`custom ${self} Zen on hides partial details`, c.render(80).length === 2);
		c.updateResult({ ...result("done"), details: { label: "final" } }, false);
		check(`custom ${self} hidden final releases native resource once`, cleanups === 1);
		const clicked = c.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 2 });
		check(`custom ${self} mouse expands full native details`, clicked?.handled && c.render(80).join("\n").includes("detail final"));
		const { createToolHtmlRenderer } = await load("core/export-html/tool-renderer.js");
		const html = createToolHtmlRenderer({ theme, cwd: "/tmp", getToolRenderers: () => resolver("custom", () => native) });
		html.renderCall("html", "custom", {});
		check(`custom ${self} HTML preserves details-only output`, html.renderResult("html", "custom", [], { label: "export" }, false)?.expanded.includes("detail export"));
	}

	for (const isError of [false, true]) {
		events.session_start({}, {});
		let redraws = 0;
		const c = component("bash", { command: "echo fixture" }, resolver("bash", () => createShellRenderers("$")), () => redraws++);
		c.markExecutionStarted();
		c.setArgsComplete();
		c.updateResult(result("partial"), true);
		c.render(80);
		c.updateResult(result(isError ? "fixture failed" : "done", isError), false);
		await wait(20);
		const before = redraws;
		await wait(1100);
		check(`final ${isError ? "error" : "success"} stops idle redraws`, redraws === before);
		check("final native timer released", !c.rendererState.interval);
		check("final status remains visible", c.render(80).join("\n").includes(isError ? "✗" : "✓"));
		// Ensure failures also clean up if this test runs against an older Zen.
		if (c.rendererState.interval) clearInterval(c.rendererState.interval);
	}

	events.session_start({}, {});
	let readCalls = 0;
	const counted = { ...readRenderers, renderCall(...args: any[]) { readCalls++; return readRenderers.renderCall(...args); } };
	const args = { path: "/tmp/zen-components/fixture.txt" };
	const read = component("read", args, resolver("read", () => counted));
	read.setArgsComplete();
	read.updateResult(result("content"), false);
	await wait(20);
	const startCalls = readCalls;
	for (let i = 0; i < 5; i++) { read.invalidate(); read.render(80); }
	check("completed read reuses native call formatting", readCalls === startCalls);
	const nativeRead = component("read", args, readRenderers);
	nativeRead.updateResult(result("content"), false);
	read.setExpanded(true);
	nativeRead.setExpanded(true);
	check("expanded read matches native lines", JSON.stringify(read.render(80)) === JSON.stringify(nativeRead.render(80)));
	read.setExpanded(false);
	const beforeTheme = readCalls;
	const darkLines = JSON.stringify(read.render(80));
	themes.setTheme("light");
	read.invalidate();
	check("read refreshes themed output without native formatting", readCalls === beforeTheme && JSON.stringify(read.render(80)) !== darkLines);
	check("read suffix survives theme change", read.render(80).join("\n").includes("✓"));
	themes.setTheme("dark");
	read.updateArgs({ path: "/tmp/zen-components/changed.txt" });
	check("read rebuilds changed arguments", read.render(80).join("\n").includes("changed.txt"));
	args.path = "/tmp/zen-components/mutated.txt";
	read.updateArgs(args);
	check("read detects in-place argument changes", read.render(80).join("\n").includes("mutated.txt"));
	check("read width respects terminal columns", read.render(40).every((line: string) => visibleWidth(line) <= 40));

	for (const isError of [false, true]) {
		const args = { query: "find fixture", options: { limit: 3 } };
		const r = result("line one\nline two\n日本語\twide\r\n\u001b[31mred\u001b[0m\u0000\n\u009b31mC1 red\u009b0m", isError);
		const compact = component("mcp__fixture__search", args, resolver("mcp__fixture__search", () => undefined));
		const bare = component("mcp__fixture__search", args, undefined);
		compact.updateResult(r, false);
		bare.updateResult(r, false);
		await wait(20);
		compact.setExpanded(true);
		bare.setExpanded(true);
		for (const width of [40, 80, 120]) {
			check(`generic ${isError ? "error" : "success"} expanded parity at ${width}`, JSON.stringify(compact.render(width)) === JSON.stringify(bare.render(width)));
		}
		compact.setOutputPad(2);
		bare.setOutputPad(2);
		check("generic outputPad parity", JSON.stringify(compact.render(80)) === JSON.stringify(bare.render(80)));
	}

	for (const expanded of [false, true]) {
		const args = { query: "registered fixture", nested: { count: 3 } };
		const r = result(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
		const registered = component("mcp__registered", args, resolver("mcp__registered", () => ({})));
		const bareRegistered = component("mcp__registered", args, {});
		registered.updateResult(r, false);
		bareRegistered.updateResult(r, false);
		await wait(20);
		registered.setExpanded(expanded);
		bareRegistered.setExpanded(expanded);
		if (!expanded) await commands.zen.handler("off", { ui: { notify() {} } });
		for (const width of [40, 80]) {
			check(`registered generic ${expanded ? "expanded" : "off"} parity at ${width}`,
				JSON.stringify(registered.render(width)) === JSON.stringify(bareRegistered.render(width)));
		}
		await commands.zen.handler("on", { ui: { notify() {} } });
	}

	// Generic expansion owns one Text wrapping pass, including image fallback.
	const argsGeneric = { query: "image" };
	const g = component("unknown", argsGeneric, resolver("unknown", () => undefined));
	const bareG = component("unknown", argsGeneric, undefined);
	const imageResult = { content: [{ type: "image", mimeType: "image/png", data: "" }], details: {}, isError: false };
	g.updateResult(imageResult, false);
	bareG.updateResult(imageResult, false);
	await wait(20);
	g.setExpanded(true);
	bareG.setExpanded(true);
	check("generic image fallback matches native", JSON.stringify(g.render(80)) === JSON.stringify(bareG.render(80)));
	check("generic expanded path uses shared Text", g.callRendererComponent instanceof Text && g.resultRendererComponent.render(80).length === 0);
	await commands.zen.handler("off", { ui: { notify() {} } });
	check("existing generic block restores native with Zen off", JSON.stringify(g.render(80)) === JSON.stringify(bareG.render(80)));
	await commands.zen.handler("on", { ui: { notify() {} } });
	g.setExpanded(false);
	check("generic block compacts again after toggle", !g.render(80).join("\n").includes("[image:"));
} finally {
	rmSync(temp, { recursive: true, force: true });
	themes.setTheme("dark");
	events.session_start({}, {});
}
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
