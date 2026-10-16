/**
 * split-config.ts — persistent startup-default config for the split extension
 * (left transcript column + right thinking/tools/file-changes column).
 * Stored at ~/.pi/agent/split.json.
 *
 * IMPORTANT: the JSON on disk is a TEMPLATE of startup defaults, NOT live
 * state. Toggle commands only mutate in-process state (session-local); only
 * /split-save writes the current layout back to disk. Concurrent pi windows
 * never clobber each other's panels.
 *
 * Geometry vocabulary:
 *   leftWidthPct  — the LEFT (transcript) column's share of the usable
 *                   terminal width (minus the 1-col divider), in percent.
 *                   The right column gets the rest. Draggable divider writes
 *                   here live (session-local until /split-save).
 *   thinkingPct / toolsPct / filesPct — the three right panels' shares of the
 *                   right column's ROWS, in percent. filesPct is the biggest
 *                   by default (user decision 2026-10-16: files gets the most
 *                   real estate). Each adjustable by command.
 *
 * Strict-typing policy (inherited from the retired ui-panels-config.ts):
 * only real booleans / real finite numbers count; absent or wrongly-typed
 * values fall back to defaults, so bad JSON can never become an accidental
 * truthy flag or a NaN geometry value.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let CONFIG_PATH = path.join(homedir(), ".pi", "agent", "split.json");

/** Test seam (repo convention): point the config file at a temp path. */
export function __setConfigPathForTest(p: string): void {
	CONFIG_PATH = p;
}

export type ToolMode = "compact" | "full";

export interface SplitConfig {
	/** Master: is the split composition active. Defaults true (new pi
	 * windows open with the split layout on); an explicit false in the
	 * saved config is always honored. */
	split?: boolean;
	/** Thinking panel in the right column. Defaults true when split is on. */
	thinking?: boolean;
	/** Tool usage panel in the right column. Defaults true when split is on. */
	tools?: boolean;
	/** File changes panel in the right column. Defaults true when split is on. */
	files?: boolean;
	/** Tool panel detail mode. */
	toolMode?: ToolMode;
	/** Left column: response-only view instead of pi's full transcript. */
	trimResponse?: boolean;
	/** LEFT column share of usable width in percent (20–80, default 60). */
	leftWidthPct?: number;
	/** Right columns: thinking panel share of rows (default 30). */
	thinkingPct?: number;
	/** Right columns: tools panel share of rows (default 25). */
	toolsPct?: number;
	/** Right columns: files panel share of rows (default 45, the biggest). */
	filesPct?: number;
}

export interface NormalizedSplitConfig {
	split: boolean;
	thinking: boolean;
	tools: boolean;
	files: boolean;
	toolMode: ToolMode;
	trimResponse: boolean;
	leftWidthPct: number;
	thinkingPct: number;
	toolsPct: number;
	filesPct: number;
}

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Strict finite-number read with fallback; NaN/garbage never leaks out. */
function numOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: fallback;
}

/** Percent clamped to [minPct, maxPct]. */
function clampPct(value: number, minPct: number, maxPct: number): number {
	return Math.max(minPct, Math.min(maxPct, value));
}

/**
 * Right-column row shares: normalize thinking/tools/files percentages to sum
 * to exactly 100, keeping their relative sizes, with a 10–70% clamp per
 * panel. The largest share keeps the remainder so rounding always closes the
 * budget.
 */
export function normalizeRightPcts(
	thinking: number,
	tools: number,
	files: number,
): { thinkingPct: number; toolsPct: number; filesPct: number } {
	const clamped = (v: number) => clampPct(v, 10, 70);
	const t = clamped(thinking);
	const o = clamped(tools);
	const f = clamped(files);
	const sum = t + o + f;
	// Largest-remainder rounding to exactly 100, remainder to the biggest panel.
	const scale = sum === 0 ? 1 : 100 / sum;
	const tR = Math.round(t * scale);
	const oR = Math.round(o * scale);
	let fR = Math.round(f * scale);
	const drift = 100 - (tR + oR + fR);
	fR += drift;
	return { thinkingPct: tR, toolsPct: oR, filesPct: fR };
}

/** Normalize raw config with defaults (never throws, tolerates any JSON shape). */
export function normalizeConfig(raw: unknown): NormalizedSplitConfig {
	const root: SplitConfig =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? (raw as SplitConfig)
			: {};
	// Default ON: a new pi window opens with the split layout composed even
	// with no saved config. An explicit false (or the --no-split flag) turns
	// it off; absent or wrongly-typed values fall back to ON, same policy as
	// the other flags below.
	const split = boolOr(root.split, true);
	const thinking = split && boolOr(root.thinking, true);
	const tools = split && boolOr(root.tools, true);
	const files = split && boolOr(root.files, true);
	const toolMode: ToolMode = root.toolMode === "full" ? "full" : "compact";
	const trimResponse = boolOr(root.trimResponse, false);
	const leftWidthPct = clampPct(
		Math.trunc(numOr(root.leftWidthPct, 60)),
		20,
		80,
	);
	const pcts = normalizeRightPcts(
		numOr(root.thinkingPct, 30),
		numOr(root.toolsPct, 25),
		numOr(root.filesPct, 45),
	);
	return {
		split,
		thinking,
		tools,
		files,
		toolMode,
		trimResponse,
		leftWidthPct,
		thinkingPct: pcts.thinkingPct,
		toolsPct: pcts.toolsPct,
		filesPct: pcts.filesPct,
	};
}

export function loadSplitConfig(): unknown {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Persist the config. Returns whether the write actually succeeded so callers
 * can report the real outcome (/split-save), never silently.
 */
export function saveSplitConfig(cfg: SplitConfig): boolean {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
		return true;
	} catch {
		return false;
	}
}

/**
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: shared config module, not an extension */
}
