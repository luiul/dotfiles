// Regression tests against Pi's actual tool components and renderers.
// Run: bun scripts/test-zen-components.ts
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zen, { makeResolver, __setConfigPathForTest } from "../pi/.pi/agent/extensions/zen.ts";

const temp = mkdtempSync(join(tmpdir(), "zen-components-"));
__setConfigPathForTest(join(temp, "zen.json"));
const cwd = "/tmp/zen-components";
const release = realpathSync(join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist"));
const load = (path: string) => import(pathToFileURL(join(release, path)).href);
const themes = await load("modes/interactive/theme/theme.js");
themes.initTheme("dark");
const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js");
const { createToolHtmlRenderer } = await load("core/export-html/tool-renderer.js");
const { createAllToolRenderers } = await load("core/tools/renderers/index.js");
const native = createAllToolRenderers();
const { Box, Text, stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, diagnostic = "") {
	console.log(`${condition ? "ok" : "FAIL"} ${name}`);
	if (!condition && diagnostic) console.log(`  ${diagnostic}`);
	condition ? pass++ : fail++;
}
const events: Record<string, Function> = {};
const commands: Record<string, any> = {};
zen({ registerFlag() {}, registerShortcut() {}, registerToolRenderer() {},
	registerCommand(name: string, def: any) { commands[name] = def; },
	on(name: string, fn: Function) { events[name] = fn; }, getFlag(name: string) { return name === "zen"; },
} as any);
const resolver = makeResolver(() => true);
const toggle = (mode: string) => commands.zen.handler(mode, { ui: { notify() {} } });
const result = (text: string, isError = false, details: any = {}) => ({
	content: [{ type: "text", text }], details, isError, durationMs: 421,
});
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
const components = new Set<any>();
const component = (tool: string, args: any, renderers: any, requestRender = () => {}, outputPad = 1) => {
	const c = new ToolExecutionComponent(tool, "fixture", args, { showImages: false, outputPad }, renderers, { requestRender }, cwd);
	components.add(c);
	return c;
};
const plain = (c: any, width = 120) => c.render(width).map(stripTerminalSequences).join("\n");
const widths = [1, 2, 12, 24, 40, 80, 120];
function compactGeometry(name: string, c: any) {
	for (const width of widths) {
		const lines = c.render(width);
		check(`${name}: two physical rows at ${width}`, lines.length === 2 && lines[0] === "", `rows=${lines.length}`);
		check(`${name}: visible width at ${width}`, lines.every((line: string) => visibleWidth(line) <= width),
			`widths=${lines.map(visibleWidth).join(",")}`);
	}
}
function parity(name: string, compact: any, bare: any, width: number) {
	const actual = compact.render(width);
	const expected = bare.render(width);
	const index = actual.findIndex((line: string, i: number) => line !== expected[i]);
	check(`${name} byte parity at ${width}`, JSON.stringify(actual) === JSON.stringify(expected),
		`rows=${actual.length}/${expected.length}, first mismatch=${index}, actual=${JSON.stringify(actual[index])}, bare=${JSON.stringify(expected[index])}`);
}
const truncation = {
	truncated: true, truncatedBy: "lines", outputLines: 24, totalLines: 200, maxLines: 24,
};
const output = Array.from({ length: 24 }, (_, i) => `OUTPUT-${i}: 日本語 e\u0301 👩‍💻\twide`).join("\n") +
	"\n\u001b[31mred\u001b[0m\u0000\n\u009b31mC1 red\u009b0m\r\nFINAL-OUTPUT-MARKER";
// A custom renderer which supplies its own frame must not gain a second Box.
const selfNative = {
	renderShell: "self",
	renderCall(args: any, theme: any, ctx: any) {
		const box = ctx.lastComponent ?? new Box(2, 1);
		box.clear();
		box.setBgFn((line: string) => theme.bg("toolPendingBg", line));
		box.addChild(new Text(`self-native\n${JSON.stringify(args, null, 2)}`, 0, 0));
		return box;
	},
	renderResult(r: any, options: any, theme: any, ctx: any) {
		const box = ctx.lastComponent ?? new Box(2, 1);
		box.clear();
		box.setBgFn((line: string) => theme.bg(ctx.isError ? "toolErrorBg" : "toolSuccessBg", line));
		const text = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		box.addChild(new Text(options.expanded ? text : text.split("\n").slice(0, 3).join("\n"), 0, 0));
		return box;
	},
};
const fixtures = [
	{ tool: "bash", args: { command: "printf 'FULL-COMMAND-MARKER\\n'\necho second-command", timeout: 17 }, renderers: native.bash, details: { truncation, fullOutputPath: "/tmp/full-output.txt" } },
	{ tool: "read", args: { path: `${cwd}/deep/nested/fixture.txt`, offset: 120, limit: 61 }, renderers: native.read, details: { truncation } },
	{ tool: "write", args: { path: `${cwd}/fixture.txt`, content: Array.from({ length: 24 }, (_, i) => `WRITE-CONTENT-${i}`).join("\n") }, renderers: native.write },
	{ tool: "edit", args: { path: `${cwd}/fixture.txt`, edits: [{ oldText: "old\nvalue", newText: "new\nvalue" }] }, renderers: native.edit, details: { diff: "  1 old\n- 2 value\n+ 2 changed", firstChangedLine: 2 } },
	{ tool: "find", args: { pattern: "**/fixture*.txt", path: cwd, limit: 10 }, renderers: native.find, details: { truncation } },
	{ tool: "grep", args: { pattern: "fixture", path: cwd, glob: "*.txt", limit: 20 }, renderers: native.grep, details: { truncation, matchLimitReached: 20 } },
	{ tool: "ls", args: { path: cwd, limit: 20 }, renderers: native.ls },
	{ tool: "mcp__registered", args: { query: "FULL-ARGS-MARKER\nsecond argument line", nested: { count: 3, label: "日本語" } }, renderers: {} },
	{ tool: "unknown", args: { query: "FULL-ARGS-MARKER\nsecond argument line", nested: { count: 3, label: "日本語" } }, renderers: undefined },
	{ tool: "mcp", args: { tool: "browser_snapshot", args: { filename: "/tmp/snapshot.md" } }, renderers: {} },
	{ tool: "self-native", args: { query: "FULL-ARGS-MARKER\nsecond argument line", nested: { count: 3 } }, renderers: selfNative },
];

try {
	for (const fixture of fixtures) {
		for (const isError of [false, true]) {
			events.session_start({}, {});
			const args = deepFreeze(structuredClone(fixture.args));
			const r = deepFreeze(result(isError ? `FAILURE-MARKER\n${output}` : output, isError, structuredClone(fixture.details ?? {})));
			const beforeInput = JSON.stringify({ args, r });
			let redraws = 0;
			const compact = component(fixture.tool, args, resolver(fixture.tool, () => fixture.renderers), () => redraws++);
			const bare = component(fixture.tool, args, fixture.renderers);
			compact.updateResult(r, false);
			bare.updateResult(r, false);
			await wait(20);
			const label = `${fixture.tool} ${isError ? "error" : "success"}`;
			compactGeometry(label, compact);
			check(`${label}: status visible`, plain(compact).includes(isError ? "✗ FAILURE-MARKER" : "✓"));
			const compactRow = compact.callRendererComponent;
			const redrawsBefore = redraws;
			for (let i = 0; i < 5; i++) {
				compact.updateResult(r, false);
				compact.invalidate();
				compact.render(80);
			}
			await wait(20);
			check(`${label}: repeated completed result has no extra redraw`, redraws === redrawsBefore);
			check(`${label}: compact row reused`, compact.callRendererComponent === compactRow);
			compact.setExpanded(true);
			bare.setExpanded(true);
			for (const width of [12, 24, 40, 80, 120]) parity(`${label} expanded`, compact, bare, width);
			compact.setOutputPad(2);
			bare.setOutputPad(2);
			parity(`${label} expanded outputPad=2`, compact, bare, 80);
			compact.setExpanded(false);
			bare.setExpanded(false);
			await toggle("off");
			for (const width of [12, 24, 40, 80, 120]) parity(`${label} runtime off`, compact, bare, width);
			compact.setOutputPad(0);
			bare.setOutputPad(0);
			parity(`${label} runtime off outputPad=0`, compact, bare, 80);
			await toggle("on");
			check(`${label}: toggle-on restores compact row`, compact.callRendererComponent === compactRow);
			compactGeometry(`${label} outputPad=0`, compact);
			check(`${label}: frozen input and result unchanged`, JSON.stringify({ args, r }) === beforeInput);
		}
	}

	events.session_start({}, {});
	let nativeReadCalls = 0;
	const countedRead = { ...native.read, renderCall(...args: any[]) { nativeReadCalls++; return native.read.renderCall(...args); } };
	const args = { path: `${cwd}/fixture.txt`, offset: 120, limit: 61 };
	const read = component("read", args, resolver("read", () => countedRead));
	read.setArgsComplete();
	read.updateResult(result("content"), false);
	await wait(20);
	const row = read.callRendererComponent;
	const darkLines = read.render(80);
	const darkText = plain(read, 80);
	const callsBefore = nativeReadCalls;
	for (let i = 0; i < 5; i++) { read.invalidate(); read.render(80); }
	check("completed compact read does not rebuild native formatting", nativeReadCalls === callsBefore);
	themes.setTheme("light");
	read.invalidate();
	check("theme change updates compact colors", JSON.stringify(read.render(80)) !== JSON.stringify(darkLines));
	check("theme change preserves compact text", plain(read, 80) === darkText);
	check("theme change reuses compact row", read.callRendererComponent === row);
	themes.setTheme("dark");
	read.invalidate();
	check("return to dark theme restores output", JSON.stringify(read.render(80)) === JSON.stringify(darkLines));
	check("read path relative to component cwd", plain(read).includes("read fixture.txt:120–180") && !plain(read).includes(cwd));
	args.path = `${cwd}/changed.txt`;
	read.updateArgs(args);
	check("read detects in-place path change", plain(read).includes("changed.txt"));
	args.offset = 201;
	args.limit = 3;
	read.updateArgs(args);
	check("read detects in-place range change", plain(read).includes("changed.txt:201–203"));
	args.path = `${cwd}/${"deeply-nested/".repeat(8)}fixture.txt`;
	args.offset = 120;
	args.limit = 61;
	read.updateArgs(args);
	check("tail-fitted read keeps filename and range at width 40", plain(read, 40).includes("fixture.txt:120–180"));
	for (const pad of [0, 1, 2]) {
		read.setOutputPad(pad);
		compactGeometry(`read resize outputPad=${pad}`, read);
		const full = read.render(120);
		read.render(24);
		check(`read width cache survives resize outputPad=${pad}`, JSON.stringify(read.render(120)) === JSON.stringify(full));
	}
	read.setOutputPad(1);
	read.updateArgs({ path: `${cwd}/日本語/e\u0301/👩‍💻/ファイル.txt` });
	compactGeometry("Unicode path", read);
	check("Unicode path remains intact at wide width", plain(read).includes("日本語/e\u0301/👩‍💻/ファイル.txt"));

	const multilineArgs = deepFreeze({ command: "printf FULL-COMMAND-MARKER\necho SECOND-COMMAND-MARKER\tend", timeout: 17 });
	const bashResult = deepFreeze(result("OUTPUT-LINE-ONE\nOUTPUT-LINE-TWO", false, { truncation, fullOutputPath: "/tmp/full-output.txt" }));
	const bash = component("bash", multilineArgs, resolver("bash", () => native.bash));
	bash.updateResult(bashResult, false);
	await wait(20);
	check("command newline and tab collapse into one row", plain(bash).includes("printf FULL-COMMAND-MARKER echo SECOND-COMMAND-MARKER end"));
	check("structured truncation is visible", plain(bash).includes("truncated"));
	bash.updateResult(result("saved", false, { fullOutputPath: "/tmp/full-output.txt" }), false);
	await wait(20);
	check("fullOutputPath without truncation is visible", plain(bash).includes("full output"));
	bash.updateResult(bashResult, false);
	await wait(20);
	bash.render(120); // Establish the self-render height for the real component's mouse handler.
	const mouse = { type: "click", button: "left", x: 5, y: 1, width: 120, height: 2, modifiers: {} };
	check("spacer click does not expand", !bash.handleMouse({ ...mouse, y: 0 })?.handled && !bash.expanded);
	check("component handles click on row y=1", bash.handleMouse(mouse)?.handled === true && bash.expanded);
	const expanded = plain(bash);
	check("click expansion retains full multiline command", expanded.split("\n").some((line: string) => line.trim() === "$ printf FULL-COMMAND-MARKER") && expanded.split("\n").some((line: string) => line.trim() === "echo SECOND-COMMAND-MARKER   end (timeout 17s)"), JSON.stringify(expanded));
	check("click expansion retains multiline output", expanded.includes("OUTPUT-LINE-ONE") && expanded.includes("OUTPUT-LINE-TWO"));
	check("click expansion retains native truncation warning", expanded.includes("Truncated: showing 24 of 200 lines"));
	check("click expansion retains full output path", expanded.includes("Full output: /tmp/full-output.txt"));
	bash.render(120);
	check("second component click collapses", bash.handleMouse(mouse)?.handled === true && !bash.expanded);
	compactGeometry("click-collapsed bash", bash);

	const narrowError = component("bash", { command: "echo a very long command" }, resolver("bash", () => native.bash));
	narrowError.updateResult({ ...result("BAD_ERROR details that need room", true), durationMs: 987654 }, false);
	await wait(20);
	check("narrow error prioritizes text over timing", plain(narrowError, 24).includes("BAD_ERROR") && !plain(narrowError, 24).includes("987.7s"));
	compactGeometry("narrow error", narrowError);
	const mcp = component("mcp", { tool: "browser_snapshot", args: { filename: "/tmp/snapshot.md" } }, resolver("mcp", () => ({})));
	mcp.updateResult(result("snapshot"), false);
	await wait(20);
	check("MCP proxy preview names the underlying operation", plain(mcp).includes("mcp browser_snapshot") && !plain(mcp).includes("[object Object]"));
	mcp.setExpanded(true);
	check("MCP expansion retains nested filename argument", plain(mcp).includes("/tmp/snapshot.md"));

	for (const renderers of [undefined, {}]) {
		const generic = component("generic-image", { query: "image" }, resolver("generic-image", () => renderers));
		const bare = component("generic-image", { query: "image" }, renderers);
		const r = deepFreeze({ content: [{ type: "image", mimeType: "image/png", data: "" }], details: {}, isError: false });
		generic.updateResult(r, false);
		bare.updateResult(r, false);
		await wait(20);
		compactGeometry(`image fallback ${renderers ? "registered" : "unknown"}`, generic);
		generic.setExpanded(true);
		bare.setExpanded(true);
		parity("image fallback expanded", generic, bare, 80);
		check("expanded image fallback visible", plain(generic).includes("[Image: [image/png]]"), JSON.stringify(plain(generic)));
		generic.setExpanded(false);
		bare.setExpanded(false);
		await toggle("off");
		parity("image fallback runtime off", generic, bare, 80);
		await toggle("on");
	}

	for (const [tool, args] of [
		["grep", { pattern: "IMPORTANT_PATTERN", path: cwd }],
		["find", { pattern: "**/*.ts", path: cwd }],
	] as const) {
		const c = component(tool, args, resolver(tool, () => native[tool]));
		c.updateResult(result("matches", false, { matchLimitReached: 20 }), false);
		await wait(10);
		check(`${tool}: pattern and location both visible`, plain(c).includes(args.pattern) && plain(c).includes(" in "));
		check(`${tool}: native limit warning visible`, plain(c).includes("truncated"));
	}
	const mcpArgs = { server: "kb", action: "install" };
	const mutableMcp = component("mcp", mcpArgs, resolver("mcp", () => ({})));
	mutableMcp.updateResult(result("done"), false);
	await wait(10);
	mcpArgs.action = "auth-start";
	mutableMcp.updateArgs(mcpArgs);
	check("MCP in-place action change invalidates summary", plain(mutableMcp).includes("auth-start"));
	const longTool = "mcp__very_long_server_tool_name";
	const longError = component(longTool, {}, resolver(longTool, () => ({})));
	longError.updateResult(result("BAD_ERROR further detail", true), false);
	await wait(10);
	check("long tool names retain failure marker and detail", plain(longError, 24).includes("✗ BAD_ERROR"));
	const mutableResult = result("OLD ERROR", true);
	longError.updateResult(mutableResult, false);
	await wait(10);
	mutableResult.content[0].text = "NEW ERROR";
	longError.updateResult(mutableResult, false);
	await wait(10);
	check("in-place error text change invalidates summary", plain(longError).includes("NEW ERROR"));
	const mutableWarning = result("done");
	mutableMcp.updateResult(mutableWarning, false);
	await wait(10);
	(mutableWarning.details as any).truncation = { truncated: true };
	mutableMcp.updateResult(mutableWarning, false);
	await wait(10);
	check("in-place details change invalidates summary", plain(mutableMcp).includes("truncated"));

	for (const renderers of [
		{ renderCall: (args: any) => new Text(`custom ${args.query}`, 0, 0) },
		{ renderShell: "self" },
		{ renderResult: (r: any, _options: any, _theme: any, ctx: any) => {
			const text = ctx.lastComponent ?? new Text("", 0, 0);
			text.setText(r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
			return text;
		} },
	]) {
		const args = { query: "custom fallback" };
		const c = component("custom-fallback", args, resolver("custom-fallback", () => renderers));
		const b = component("custom-fallback", args, renderers);
		const r = { content: [{ type: "image", mimeType: "image/png", data: "" }, { type: "text", text: output }], details: {}, isError: false };
		c.updateResult(r, false);
		b.updateResult(r, false);
		await wait(10);
		for (const expanded of [true, false]) {
			c.setExpanded(expanded); b.setExpanded(expanded);
			if (!expanded) await toggle("off");
			parity(`partial custom definition ${expanded ? "expanded" : "off"}`, c, b, 80);
			await toggle("on");
		}
	}

	const formattedNative = {
		renderCall: () => new Text("custom details", 0, 0),
		renderResult: (r: any, _o: any, _t: any, ctx: any) => {
			const text = ctx.lastComponent ?? new Text("", 0, 0);
			text.setText(`FORMATTED_DETAILS ${r.details.marker}`);
			(text as any).handleMouse = () => { text.setText("AFTER_CUSTOM_CLICK"); return { handled: true, render: true }; };
			return text;
		},
	};
	const wrappedFormatted = resolver("custom-details", () => formattedNative);
	const html = createToolHtmlRenderer({ getToolRenderers: () => wrappedFormatted, theme: themes.theme, cwd });
	html.renderCall("export-test", "custom-details", {});
	const exported = html.renderResult("export-test", "custom-details", [{ type: "text", text: "RAW_OUTPUT" }], { marker: "DETAIL_MARKER" }, false);
	check("HTML export retains custom details formatting", exported?.expanded?.includes("FORMATTED_DETAILS") && exported?.expanded?.includes("DETAIL_MARKER"));
	const clickable = component("custom-details", {}, wrappedFormatted);
	clickable.updateResult(result("RAW_OUTPUT", false, { marker: "DETAIL_MARKER" }), false);
	clickable.setExpanded(true);
	clickable.render(80);
	const click = clickable.handleMouse({ type: "click", button: "left", x: 3, y: 3, width: 80, height: 5, modifiers: {} });
	check("custom mouse update requests rendering", click?.handled === true);
	check("custom mouse update paints immediately", plain(clickable, 80).includes("AFTER_CUSTOM_CLICK"));
	clickable.rendererState.zenResult.setText("EXTERNAL_NATIVE_UPDATE");
	check("custom child update paints without enclosing invalidate", plain(clickable, 80).includes("EXTERNAL_NATIVE_UPDATE"));

	for (const isError of [false, true]) {
		events.session_start({}, {});
		let redraws = 0;
		const c = component("bash", { command: "echo no-partial" }, resolver("bash", () => native.bash), () => redraws++);
		c.markExecutionStarted();
		c.setArgsComplete();
		check("running bash records native start time without partial result", c.rendererState.startedAt !== undefined && !c.rendererState.interval);
		c.updateResult(result(isError ? "failed" : "done", isError), false);
		await wait(20);
		check("native timer released without a partial result", !c.rendererState.interval);
		const before = redraws;
		await wait(1100);
		check("no idle redraws without a partial result", before === redraws);
	}

	for (const tool of ["bash", "powershell"]) {
		for (const isError of [false, true]) {
			events.session_start({}, {});
			let redraws = 0;
			const c = component(tool, { command: "echo fixture" }, resolver(tool, () => native[tool]), () => redraws++);
			c.markExecutionStarted();
			c.setArgsComplete();
			c.updateResult(result("partial"), true);
			const streaming = plain(c, 80);
			check(`${tool}: streaming native preview visible`, streaming.includes("partial") && streaming.includes("Elapsed"));
			check(`${tool}: streaming timer starts`, !!c.rendererState.interval);
			c.updateResult(result(isError ? "fixture failed" : "done", isError), false);
			await wait(20);
			const before = redraws;
			await wait(1100);
			check(`${tool}: final ${isError ? "error" : "success"} stops idle redraws`, redraws === before);
			check(`${tool}: final native timer released`, !c.rendererState.interval);
			compactGeometry(`${tool} final streaming ${isError ? "error" : "success"}`, c);
		}
	}
} finally {
	// Release native timers even when an assertion throws against a broken build.
	for (const c of components) if (c.rendererState.interval) clearInterval(c.rendererState.interval);
	rmSync(temp, { recursive: true, force: true });
	themes.setTheme("dark");
	events.session_start({}, {});
}
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
