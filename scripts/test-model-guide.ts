import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
type Settings = ReturnType<ExtensionAPI["getSettings"]>;
import { initTheme, getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../pi/.pi/agent/extensions/model-guide.ts";
import { detailLines, guideRows, intelligence, loadEvidence, parseEvidence, plain, price } from "../pi/.pi/agent/extensions/model-guide/data.ts";
import { GuideView } from "../pi/.pi/agent/extensions/model-guide/view.ts";

let command: any;
const calls: string[] = [];
const pi = new Proxy({ registerCommand(name: string, options: any) {
	assert.equal(name, "model-guide"); command = options; calls.push(name);
} }, { get(target, key) {
	assert.equal(key, "registerCommand", `Unexpected startup resource ${String(key)}`);
	return Reflect.get(target, key);
} }) as unknown as ExtensionAPI;
extension(pi);
assert.deepEqual(calls, ["model-guide"]);
for (const mode of ["rpc", "print", "json"]) {
	await command.handler("", { mode, hasUI: mode === "rpc", ui: { notify() {} } } as unknown as ExtensionCommandContext);
}
console.log("PASS command-only registration and non-TUI guard; no hooks, tools or startup evidence reads");

const text = readFileSync(new URL("../pi/.pi/agent/model-guide.json", import.meta.url), "utf8");
const data = parseEvidence(text);
assert.equal(data.warning, undefined);
assert.equal(Object.keys(data.evidence).length, 7);
for (const malformed of ["{}", "null", "{bad", '{"version":1,"models":[]}']) assert(parseEvidence(malformed).warning);
const raw = JSON.parse(text), key = "ai-model-router/GPT-6.1 Terra";
for (const field of ["score", "url", "reviewed", "effort"]) {
	const altered = structuredClone(raw); altered.models[key][field] = field === "score" ? -1 : field === "reviewed" ? "2026-02-30" : "";
	const result = parseEvidence(JSON.stringify(altered)); assert(result.warning); assert(!result.evidence[key]);
	assert.equal(Object.keys(result.evidence).length, 6);
}
const temp = mkdtempSync(join(tmpdir(), "model-guide-unit-"));
try {
	assert((await loadEvidence(join(temp, "missing"))).warning);
	writeFileSync(join(temp, "bad"), "not JSON"); assert((await loadEvidence(join(temp, "bad"))).warning);
} finally { rmSync(temp, { recursive: true, force: true }); }
assert.equal(plain("a\x1b[31mb\x1b[0m\x1b]0;hidden\x07\n"), "ab");
console.log("PASS evidence schema, corrupt records, invalid dates, missing files and terminal controls");

const models = JSON.parse(readFileSync(new URL("../pi/.pi/agent/models.json", import.meta.url), "utf8"));
const settings = JSON.parse(readFileSync(new URL("../pi/.pi/agent/settings.json", import.meta.url), "utf8")) as Settings;
const scope = settings.enabledModels!.map(id => {
	const slash = id.indexOf("/"), provider = id.slice(0, slash), modelId = id.slice(slash + 1);
	const m = models.providers[provider].models?.find((m: any) => m.id === modelId) ?? {
		id: modelId, name: models.providers[provider].modelOverrides[modelId].name, reasoning: true,
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 1048576,
	};
	return { model: { ...m, provider } };
});
const rows = guideRows(scope, settings, key, "low", data.evidence);
assert.deepEqual(rows.map(x => x.key), settings.enabledModels);
assert.equal(rows[0].current, "low"); assert.equal(rows[0].configured, "high");
assert.equal(rows[1].role, "Code"); assert.equal(rows[1].configured, "high");
assert.equal(rows[2].configured, "medium");
assert.equal(intelligence(rows[0]).text, "II 42 @ high");
assert(intelligence(rows[1]).text.includes("unknown at high"));
assert(intelligence(rows[3]).text.includes("published 32 @ max"));
assert(intelligence(rows.at(-1)!).text.includes("unknown at off"));
const pattern = guideRows([{ ...scope[0], thinkingLevel: "xhigh" }], settings, undefined, "low", data.evidence);
assert.equal(pattern[0].configured, "xhigh"); assert.equal(pattern[0].effortSource, "scope pattern");
assert.deepEqual(guideRows([], settings, undefined, "off", data.evidence), []);
const extra = { model: { ...scope[0].model, id: "not-curated", name: "Mystery" } };
const unknown = guideRows([extra], settings, undefined, "high", data.evidence)[0];
assert.equal(unknown.evidence, undefined); assert.equal(unknown.configured, undefined);
assert.equal(intelligence(unknown).text, "II unknown");
assert.equal(price(0), "$0 (catalog)"); assert.equal(price(undefined), "unknown"); assert.equal(price(NaN), "unknown");
assert(detailLines(rows[0], "2026-01-01").some(x => x.text.includes("future date") && x.warning));
assert(detailLines(unknown).some(x => x.text.includes("no curated purpose")));
console.log("PASS exact scope order, pattern/pin/current effort separation, unknown models, effort mismatches and catalog prices");

initTheme("dark", false);
let renders = 0, closed = 0;
const tui = { terminal: { rows: 24 }, requestRender() { renders++; } } as any;
const kb = getKeybindings();
for (const name of ["dark", "light"]) {
	const theme = getThemeByName(name)!;
	const view = new GuideView(rows, theme, kb, tui, () => closed++);
	view.focused = true;
	for (const width of [40, 60, 120]) {
		const lines = view.render(width);
		assert(lines.length <= 16, `height overflow ${width}: ${lines.length}`);
		assert(lines.every(x => visibleWidth(x) <= width), `width overflow ${width}`);
		assert(lines.join("\n").includes("Terra"));
	}
	view.handleInput("\x1b[B"); assert(view.render(120).join("\n").includes("II unknown at high"));
	view.handleInput("\t"); view.handleInput("\x1b[6~");
	const later = view.render(40).join("\n"); assert(!later.includes("Details (focused) 1/"));
	view.handleInput("\t"); view.handleInput("think");
	assert(view.render(120).join("\n").includes("Sol"));
	assert(!view.render(120).join("\n").includes("Kimi"));
	view.handleInput("\x1b");
	const empty = new GuideView([], theme, kb, tui, () => {});
	assert(empty.render(40).join("\n").includes("No scope configured"));
	const noMatch = new GuideView(rows, theme, kb, tui, () => {}, "no-such-model");
	assert(noMatch.render(40).join("\n").includes("No matching models"));
}
assert.equal(closed, 2); assert(renders > 0);
console.log("PASS search, navigation, detail paging, cancellation, width/height bounds and light/dark theme rendering");

for (const terminalRows of [5, 8, 12, 17, 24]) {
	for (const width of [1, 2, 5, 19, 20, 39, 40]) {
		for (const entries of [rows, []]) {
			const tiny = new GuideView(entries, getThemeByName("dark")!, kb,
				{ ...tui, terminal: { rows: terminalRows } }, () => {}, "", "Evidence unavailable");
			const frame = tiny.render(width);
			assert(frame.length <= Math.max(1, terminalRows - 8), `height overflow ${width}x${terminalRows}: ${frame.length}`);
			assert(frame.every(line => visibleWidth(line) <= width), `width overflow ${width}x${terminalRows}`);
		}
	}
}
console.log("PASS tiny and short terminals, including empty scope and evidence warnings");

const view = new GuideView(rows, getThemeByName("dark")!, kb, { ...tui, terminal: { rows: 40 } }, () => {});
const start = performance.now();
for (let i = 0; i < 1000; i++) view.render(100);
console.log(`Render check: ${((performance.now() - start) / 1000).toFixed(3)} ms/render (1000 renders, seven rows)`);
