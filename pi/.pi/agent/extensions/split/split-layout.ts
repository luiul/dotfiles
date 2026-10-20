/**
 * split-layout.ts — shared owner of pi's single fullscreen layout-root slot,
 * plus the draggable vertical divider component.
 *
 * Same single-layer discipline as the retired layout-manager.ts: extensions
 * that wrap the layout root fight over one slot if they each capture and
 * restore `tui.layoutRoot` independently. This manager owns the slot — it
 * captures the true base root once, keeps an ordered set of active "layers"
 * (each a wrap builder), and on any toggle rebuilds the composition
 * `baseRoot → layer1 → layer2 → …` and re-applies it. Closing one layer
 * leaves the others intact.
 *
 * Survives /reload via globalThis: a fresh module unwraps any stale
 * composition back to the base root before re-applying its own layers.
 *
 * Single-TUI-context assumption (inherited from SV-20): exactly one tuiRef /
 * baseRoot / layer map per process. Simultaneous TUI contexts in one process
 * are unverified and unsupported.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const REG_KEY = Symbol.for("pi.split-layout");

/** A layer is a wrap builder: receives the inner root, returns the wrapped root. */
type LayerBuild = (inner: Component) => Component;

interface Manager {
	gen: number;
	tuiRef: any;
	baseRoot: Component | null;
	layers: Map<string, LayerBuild>;
}

const G = globalThis as Record<symbol, Manager>;
const M: Manager = G[REG_KEY] ?? {
	gen: 0,
	tuiRef: null,
	baseRoot: null,
	layers: new Map(),
};
G[REG_KEY] = M;

/**
 * Register the live TUI and (re)establish the base root. Call from a widget
 * factory or session_start. If a stale composition from a previous module
 * generation is present, unwrap it back to the base root first.
 */
export function initLayoutManager(tui: any): void {
	M.tuiRef = tui;
	if (M.baseRoot && tui.layoutRoot !== M.baseRoot) {
		// Stale composition left by a /reload'd module — restore the base root.
		try {
			tui.setLayoutRoot(M.baseRoot);
			tui.requestRender?.(true);
		} catch {
			/* not a viewport TUI */
		}
		M.layers.clear();
	}
	if (!M.baseRoot) {
		M.baseRoot = tui.layoutRoot as Component | null;
	}
}

/**
 * Add (or remove, with null) a layout layer. Rebuilds the composed root.
 * `build` receives the inner root and returns the wrapped root.
 */
export function setLayoutLayer(
	id: string,
	build: ((inner: Component) => Component) | null,
): void {
	if (build === null) {
		M.layers.delete(id);
	} else {
		M.layers.set(id, build);
	}
	applyLayout();
}

export function isLayoutLayerActive(id: string): boolean {
	return M.layers.has(id);
}

/** The captured base root (pi's own fullscreen layout root), or null. */
export function getBaseRoot(): Component | null {
	return M.baseRoot;
}

function applyLayout(): void {
	if (!M.tuiRef || !M.baseRoot) return;
	let root = M.baseRoot;
	for (const build of M.layers.values()) {
		root = build(root);
	}
	try {
		M.tuiRef.setLayoutRoot(root);
	} catch {
		/* ignore */
	}
	try {
		// Force a FULL repaint, not a diff frame: the first frame of the new
		// composition must never be diffed against the previous composition's
		// screen buffer (setLayoutRoot only schedules a throttled render
		// without resetting diff state — stale diffs paint blank regions).
		M.tuiRef.requestRender?.(true);
	} catch {
		/* ignore */
	}
}

/**
 * Self-heal: pi resets the layout root on a TUI-mode switch (regular↔fullscreen)
 * with no event. Call on each render; if the live root no longer matches our
 * composition, re-apply the layers.
 */
export function selfHealLayout(): void {
	if (!M.tuiRef || !M.baseRoot || M.layers.size === 0) return;
	let composed: Component | null = null;
	try {
		composed = M.tuiRef.layoutRoot as Component | null;
	} catch {
		return;
	}
	if (composed === M.baseRoot) {
		applyLayout();
	}
}

/** Restore the base root and clear all layers (on session shutdown). */
export function resetLayoutManager(): void {
	if (M.tuiRef && M.baseRoot) {
		try {
			M.tuiRef.setLayoutRoot(M.baseRoot);
			M.tuiRef.requestRender?.(true);
		} catch {
			/* ignore */
		}
	}
	M.layers.clear();
}

// ─── drag divider ─────────────────────────────────────────────────────────────

export interface DragDividerOptions {
	theme: Theme;
	/** Live terminal columns (for pct math from absolute mouse coords). */
	termCols: () => number;
	/** Live terminal rows (one blank row at rest, one accent | while dragging). */
	termRows: () => number;
	/** Read the current left-share percent. */
	getLeftPct: () => number;
	/** Store a new left-share percent (clamped by the caller or here). */
	setLeftPct: (pct: number) => void;
	/** Recompose the layout after a pct change. */
	onPctChange: () => void;
	/** Only the press on the divider starts a drag; capture routes the rest. */
}

/**
 * The 1-column vertical divider between the transcript column and the right
 * panel column. Minimal by design: blank at rest (no ink at all), a single
 * accent ASCII | column while a drag is in progress. ASCII rather than │
 * because a full-height box-drawing column renders with artifacts in the
 * VS Code integrated terminal (xterm.js font pipeline); ASCII renders
 * single-cell in every terminal. The grab area is exactly this 1 column,
 * but a press CAPTURES the drag, so every subsequent move/release event is
 * routed here even far outside the divider's bounds — no wide invisible
 * grab strip is needed.
 *
 * pct math uses the event's ABSOLUTE terminal x (screenX): local x would be
 * useless during capture once the pointer leaves the column.
 */
export class DragDivider implements Component {
	private dragging = false;
	private cacheRows = -1;
	private cacheLines: string[] = [];

	constructor(private opts: DragDividerOptions) {}

	private line(): string {
		const th = this.opts.theme;
		// Blank at rest: no ink. While dragging, accent ASCII | (VS Code safe).
		return this.dragging ? th.fg("accent", "|") : " ";
	}

	render(_width: number): string[] {
		const rows = Math.max(1, this.opts.termRows());
		if (rows !== this.cacheRows) {
			this.cacheRows = rows;
			const l = this.line();
			this.cacheLines = Array.from({ length: rows }, () => l);
		} else if (this.cacheLines.length && this.cacheLines[0] !== this.line()) {
			// Color-only change (drag started/ended): rebuild cheaply.
			const l = this.line();
			this.cacheLines = this.cacheLines.map(() => l);
		}
		return this.cacheLines;
	}

	invalidate(): void {
		this.cacheRows = -1;
		this.cacheLines = [];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "press" && event.button === "left") {
			this.dragging = true;
			this.invalidate();
			// capture: all move/drag/release events route here from now on.
			return { handled: true, capture: true, render: true };
		}
		if (
			this.dragging &&
			(event.type === "drag" || event.type === "move") &&
			event.button === "left"
		) {
			const cols = this.opts.termCols();
			if (cols > 0) {
				// leftPct = divider's absolute column over terminal width,
				// clamped to the 20–80 band.
				const pct = Math.round((event.screenX / cols) * 100);
				const next = Math.max(20, Math.min(80, pct));
				if (next !== this.opts.getLeftPct()) {
					this.opts.setLeftPct(next);
					this.opts.onPctChange();
				}
			}
			return { handled: true, render: false };
		}
		if (event.type === "release") {
			if (!this.dragging) return undefined;
			this.dragging = false;
			this.invalidate();
			return { handled: true, render: true };
		}
		// Wheel and other buttons pass through to the nearest ScrollView.
		return undefined;
	}

	dispose(): void {}
}
