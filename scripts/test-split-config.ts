// Unit tests for the split extension's config and drag divider:
// - normalizeConfig: defaults, strict typing (garbage JSON never becomes
//   truthy flags or NaN geometry), clamps.
// - normalizeRightPcts: shares always sum to exactly 100, per-panel 10-70
//   clamp, remainder to the biggest share.
// - saveSplitConfig/loadSplitConfig roundtrip via the module's test seam.
// - DragDivider: press captures, drag maps absolute screenX to the 20-80
//   pct band, release ends the drag, wheel passes through, render paints
//   one │ per terminal row.
//
// Run: bun scripts/test-split-config.ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Config file path is redirected via the module's test seam (bun's os.homedir()
// ignores $HOME, so a temp-HOME override does not work — never write the real
// ~/.pi/agent/split.json from tests).
const TMP = mkdtempSync(join(tmpdir(), "split-cfg-"));

const {
	normalizeConfig,
	normalizeRightPcts,
	saveSplitConfig,
	loadSplitConfig,
	__setConfigPathForTest,
} = await import("../pi/.pi/agent/extensions/split/split-config.ts");
const { DragDivider } = await import("../pi/.pi/agent/extensions/split/split-layout.ts");

__setConfigPathForTest(join(TMP, "split.json"));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
	}
}

// --- normalizeConfig ------------------------------------------------------------
{
	const d = normalizeConfig({ split: true });
	check("panels default ON when split is on, files biggest", d.split && d.thinking && d.tools && d.files, d);
	check("sticky default ON when split is on", d.sticky, d);
	const bare = normalizeConfig({});
	check("no config: split ON by default (new windows open split)", bare.split && bare.thinking && bare.tools && bare.files && !bare.trimResponse, bare);
	check("no config: sticky ON by default", bare.sticky, bare);
	const off = normalizeConfig({ split: false });
	check("explicit split false honored: every panel flag off", !off.split && !off.thinking && !off.tools && !off.files, off);
	check("explicit split false: sticky off too", !off.sticky, off);
}
{
	const c = normalizeConfig({ split: true, thinking: false, tools: true, files: false, toolMode: "full", trimResponse: true, sticky: false, leftWidthPct: 75, thinkingPct: 20, toolsPct: 20, filesPct: 60 });
	check("explicit flags honored", c.split && !c.thinking && c.tools && !c.files && c.toolMode === "full" && c.trimResponse);
	check("explicit sticky false honored", !c.sticky, c);
	check("explicit geometry honored", c.leftWidthPct === 75 && c.filesPct === 60);
}
{
	// Strict typing: garbage shapes must fall back to defaults, never throw.
	for (const raw of [null, [], "yes", 42, { split: "yes" }, { split: true, thinking: 1 }, { sticky: 1 }, { sticky: "yes" }, { leftWidthPct: "60" }, { leftWidthPct: NaN }, { leftWidthPct: Infinity }, { thinkingPct: () => 30 }]) {
		const c = normalizeConfig(raw as never);
		check(`garbage tolerated: ${JSON.stringify(String(raw)).slice(0, 40)}`, typeof c.leftWidthPct === "number" && Number.isFinite(c.leftWidthPct) && c.thinking === c.split && c.sticky === c.split && !Number.isNaN(c.thinkingPct + c.toolsPct + c.filesPct), c);
	}
}
{
	// Clamps.
	const c = normalizeConfig({ leftWidthPct: 5, thinkingPct: 90, toolsPct: 90, filesPct: 90 });
	check("leftWidthPct clamps to 20", c.leftWidthPct === 20, c.leftWidthPct);
	check("right pcts clamp and renormalize to 100", c.thinkingPct + c.toolsPct + c.filesPct === 100, c);
}

// --- normalizeRightPcts ---------------------------------------------------------
{
	const p = normalizeRightPcts(30, 25, 45);
	check("30/25/45 exact", p.thinkingPct === 30 && p.toolsPct === 25 && p.filesPct === 45, p);
}
{
	const p = normalizeRightPcts(33, 33, 33);
	check("thirds sum to 100", p.thinkingPct + p.toolsPct + p.filesPct === 100, p);
}
{
	const p = normalizeRightPcts(50, 5, 5);
	// tools clamps up to 10, renormalized proportionally; biggest keeps remainder.
	check("clamped small shares survive", p.toolsPct >= 10 && p.filesPct >= 10, p);
	check("still sums to 100 after clamps", p.thinkingPct + p.toolsPct + p.filesPct === 100, p);
}
{
	const p = normalizeRightPcts(0, 0, 0);
	check("all-zero still sums to 100", p.thinkingPct + p.toolsPct + p.filesPct === 100, p);
}

// --- config roundtrip (temp HOME) -----------------------------------------------
{
	const ok = saveSplitConfig({ split: true, thinking: true, tools: false, files: true, trimResponse: false, sticky: true, leftWidthPct: 66, thinkingPct: 25, toolsPct: 20, filesPct: 55 });
	check("save reports success", ok);
	check("save writes the file", existsSync(join(TMP, "split.json")));
	const c = normalizeConfig(loadSplitConfig());
	check("roundtrip: flags", c.split && c.thinking && !c.tools && c.files);
	check("roundtrip: sticky", c.sticky, c);
	check("roundtrip: geometry", c.leftWidthPct === 66 && c.thinkingPct === 25 && c.toolsPct === 20 && c.filesPct === 55, c);
}

// --- DragDivider -----------------------------------------------------------------
const th = { fg: (_t: string, s: string) => s } as never;
let pct = 60;
let recomposes = 0;
const divider = new DragDivider({
	theme: th,
	termCols: () => 100,
	termRows: () => 24,
	getLeftPct: () => pct,
	setLeftPct: (p) => {
		pct = p;
	},
	onPctChange: () => {
		recomposes++;
	},
});
const ev = (type: string, screenX: number, button = "left") =>
	({ type, button, x: 0, y: 0, screenX, screenY: 0, width: 1, height: 24, shift: false, alt: false, ctrl: false }) as never;

{
	const r = divider.handleMouse(ev("press", 60));
	check("press captures", !!(r && (r as any).handled && (r as any).capture), r);
}
{
	pct = 60;
	recomposes = 0;
	divider.handleMouse(ev("drag", 55));
	check("drag sets pct from absolute x", pct === 55, pct);
	check("recompose fired", recomposes === 1);
	divider.handleMouse(ev("drag", 3));
	check("drag clamps low to 20", pct === 20, pct);
	divider.handleMouse(ev("drag", 97));
	check("drag clamps high to 80", pct === 80, pct);
	divider.handleMouse(ev("drag", 80));
	check("no recompose when pct unchanged", recomposes === 3, recomposes);
}
{
	const r = divider.handleMouse(ev("release", 81, "none"));
	check("release handled", !!(r && (r as any).handled), r);
	const w = divider.handleMouse(ev("wheel", 0, "none"));
	check("wheel passes through after release", w === undefined, w);
	pct = 60;
	recomposes = 0;
	divider.handleMouse(ev("drag", 50)); // stray drag with no capture active
	check("stray drag without press is ignored", pct === 60 && recomposes === 0, { pct, recomposes });
}
{
	const lines = divider.render(1);
	check("render paints one line per terminal row", lines.length === 24, lines.length);
	divider.invalidate();
	check("invalidate clears cache", divider.render(1).length === 24);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
