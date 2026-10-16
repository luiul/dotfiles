/**
 * split-files.ts — the File Changes panel for the split extension's right
 * column. Renders the shared tracker from filechanges-tracker.ts (the same
 * tracking state as the filechanges.ts above-editor widget) as a scrollable
 * list plus a pinned diff subpanel.
 *
 * Layout inside the section's row budget:
 *
 *     File Changes (7 · round) ────────────   ← 1-row header (count + mode)
 *     │ modified src/a.ts (+12/-3) staged    ← list, newest at the bottom,
 *     │ created  b.md (+8)                     ScrollView follows the end
 *     ├ ✎ src/a.ts ─────────────────────────  ← diff subpanel header
 *     │ ⋯ unified diff, original → current
 *
 * - List rows are ONE visual row each (truncate, no wrap) so mouse clicks map
 *   exactly: row = scrollTop + (y - 1). Click selects the entry whose diff is
 *   pinned in the subpanel; the newest change is pinned by default and a
 *   selection follows the newest until the user clicks. Entries render
 *   NEWEST-FIRST (the tracker's order, same as the /filechanges widget), so
 *   the list does not follow the end: the viewport stays at the top where
 *   the newest change lands.
 * - Round/all scope follows the tracker's mode (shared with /filechanges-mode,
 *   /filechanges): the panel and the old widget are two views of one state.
 * - While this panel is active, split.ts suppresses the filechanges.ts widget
 *   via the same tracker (nothing is shown twice). This module owns that
 *   suppression call on split's behalf (setFilesSuppressed).
 * - Diffs are computed with pi's generateDiffString from the tracker's
 *   Original snapshot to the CURRENT file content, cached per (path, version).
 *   Binary files show "(binary)".
 *
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */

import {
	generateDiffString,
	renderDiff,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	MouseRegion,
	ScrollView,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	getSharedFileChangesTracker,
	type FileChange,
	type FileChangesTracker,
} from "./filechanges-tracker.ts";
import { MeasurementSafeVStack } from "./split-render.ts";
import { readFileSync } from "node:fs";

// ─── module state (single-session-per-process assumption) ────────────────────

let tracker: FileChangesTracker | null = null;
let unsubscribe: (() => void) | null = null;
/** Bumped on every tracker state change (drives the list cache key). */
let filesVersion = 0;
/** Selected entry (absolute path); null = follow the newest. */
let selectedPath: string | null = null;
let renderHook: (() => void) | null = null;

/**
 * Bind the panel to the session's shared tracker. Idempotent: the first call
 * subscribes once; later calls (new compositions, /reload) reuse the
 * subscription. Call from split.ts session_start BEFORE any suppression call.
 */
export function initFilesPanel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (tracker) return;
	try {
		tracker = getSharedFileChangesTracker(pi, ctx);
	} catch {
		tracker = null;
		return;
	}
	if (tracker && !unsubscribe) {
		unsubscribe = tracker.subscribe(() => {
			filesVersion++;
			// A selected file may have been cleared or reverted away.
			if (selectedPath && !findChange(selectedPath)) selectedPath = null;
			try {
				renderHook?.();
			} catch {
				/* ignore */
			}
		});
	}
}

/**
 * Suppress (or restore) the filechanges.ts above-editor widget. The tracker
 * is the single source of truth for that decision; tracking always continues.
 */
export function setFilesSuppressed(active: boolean): void {
	try {
		tracker?.setWidgetSuppressed(active);
	} catch {
		/* ignore */
	}
}

/** Release the subscription (session shutdown). */
export function disposeFilesPanel(): void {
	try {
		unsubscribe?.();
	} catch {
		/* ignore */
	}
	unsubscribe = null;
	tracker = null;
	selectedPath = null;
	filesVersion = 0;
}

// ─── data helpers ────────────────────────────────────────────────────────────

function entries(): FileChange[] {
	if (!tracker) return [];
	try {
		return tracker.getChanges();
	} catch {
		return [];
	}
}

function findChange(absPath: string): FileChange | undefined {
	return entries().find((e) => e.absolutePath === absPath);
}

/** The pinned entry: the user's selection, else the newest change (list head). */
function pinnedChange(): FileChange | null {
	if (!tracker) return null;
	if (selectedPath) {
		const hit = findChange(selectedPath);
		if (hit) return hit;
	}
	const list = entries();
	return list.length ? list[0] : null;
}

/** Short display path relative to cwd, else ~-relative, else absolute. */
function displayPath(absPath: string): string {
	const cwd = process.cwd();
	if (absPath.startsWith(cwd + "/")) return absPath.slice(cwd.length + 1);
	const home = process.env.HOME ?? "";
	if (home && absPath.startsWith(home + "/")) return `~${absPath.slice(home.length)}`;
	return absPath;
}

// ─── diff subpanel ───────────────────────────────────────────────────────────

interface DiffCache {
	path: string | null;
	version: number;
	lines: string[];
}

let diffCache: DiffCache = { path: null, version: -1, lines: [] };

/**
 * Compute (and cache) the pinned diff: Original snapshot → current content.
 * File I/O happens only on (path, version) changes, never per frame.
 */
function pinnedDiffLines(): string[] {
	const pinned = pinnedChange();
	if (!pinned || !tracker) return [];
	if (
		diffCache.path === pinned.absolutePath &&
		diffCache.version === filesVersion
	)
		return diffCache.lines;
	let lines: string[] = [];
	try {
		if (pinned.binary) {
			lines = ["(binary file)"];
		} else {
			const original = tracker.getOriginal(pinned.path)?.content ?? "";
			let current = "";
			try {
				current = readFileSync(pinned.absolutePath, "utf8");
			} catch {
				current = ""; // deleted or unreadable → diff to empty
			}
			if (original === current) lines = ["(no changes vs original)"];
			else {
				const d = generateDiffString(original, current, 3).diff;
				lines = d ? renderDiff(d).split(/\r?\n/) : [];
			}
		}
	} catch {
		lines = [];
	}
	diffCache = { path: pinned.absolutePath, version: filesVersion, lines };
	return lines;
}

/**
 * The diff subpanel: a title row (✎ path) + up to `rows` - 1 diff rows,
 * padded to an exact height so the section closes on its budget.
 */
class DiffBody implements Component {
	private cacheKey = "";
	private cacheLines: string[] = [];

	constructor(private theme: Theme, private rows: () => number) {}

	render(width: number): string[] {
		const th = this.theme;
		const height = Math.max(2, this.rows());
		const inner = Math.max(1, width - 1);
		const key = `${filesVersion}|${pinnedChange()?.absolutePath ?? ""}|${width}|${height}`;
		if (key === this.cacheKey) return this.cacheLines;

		const pad = (s: string) =>
			s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const edge = (s: string) => th.fg("border", "│") + pad(s);
		const out: string[] = [];
		const pinned = pinnedChange();
		// Title: ✎ + path, truncated by DISPLAY columns.
		const title = pinned
			? " " + th.fg("accent", `✎ ${truncateToWidth(displayPath(pinned.absolutePath), inner - 2, "…")}`)
			: " " + th.fg("dim", " ✎ diff");
		const titleFill = "─".repeat(Math.max(0, inner - visibleWidth(title)));
		out.push(
			th.fg("border", "├") + title + th.fg("border", titleFill),
		);
		const bodyRows = height - 1;
		const lines = pinnedDiffLines();
		if (lines.length === 0) {
			out.push(edge(" " + th.fg("dim", pinned ? "(no diff)" : "No changes yet")));
		} else {
			const shown = lines.slice(0, Math.max(0, bodyRows - 1));
			for (const l of shown) out.push(edge(" " + truncateToWidth(l, inner - 1, "…")));
			if (lines.length > shown.length && bodyRows > 0)
				out.push(edge(" " + th.fg("dim", `… +${lines.length - shown.length} more`)));
		}
		while (out.length < height) out.push(th.fg("border", "│") + " ".repeat(inner));
		this.cacheKey = key;
		this.cacheLines = out;
		return out;
	}

	invalidate(): void {
		this.cacheKey = "";
	}
	dispose(): void {}
}

// ─── list body ───────────────────────────────────────────────────────────────

/**
 * The changes list: one visual row per entry (truncate, never wrap),
 * NEWEST-FIRST (the tracker's order, same as the filechanges widget). The
 * ScrollView does not follow the end — the top of the list is the newest
 * change, which is where the eye goes. Rows carry the same semantic colors
 * as the filechanges widget: kind word colored, path plain, +A/-R in diff
 * colors, repo state as quiet metadata. The pinned row gets a ▸ marker.
 */
class FilesListBody implements Component {
	private cacheVersion = -1;
	private cacheSelected: string | null = "?";
	private cacheWidth = -1;
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Rows to guarantee so the left │ edge stays continuous (viewport height). */
		private minRows: () => number = () => 1,
	) {}

	render(width: number): string[] {
		const v = filesVersion;
		const sel = selectedPath ?? pinnedChange()?.absolutePath ?? null;
		if (v !== this.cacheVersion || sel !== this.cacheSelected) {
			this.cacheVersion = v;
			this.cacheSelected = sel;
			this.cacheLines = [];
		}
		if (this.cacheLines.length && this.cacheWidth === width) return this.cacheLines;
		this.cacheWidth = width;

		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const edge = th.fg("border", "│");
		const filler = edge + " ".repeat(Math.max(0, inner - 1));
		const list = entries();
		const out: string[] = [];
		if (list.length === 0) {
			const empty = " " + th.fg("dim", "No changes yet");
			out.push(edge + empty + " ".repeat(Math.max(0, inner - visibleWidth(empty))));
			while (out.length < this.minRows()) out.push(filler);
			return out;
		}
		for (const e of list) {
			const mark = e.absolutePath === sel ? "▸" : " ";
			const kind =
				e.kind === "created"
					? th.fg("success", "created ")
					: e.kind === "deleted"
						? th.fg("error", "deleted ")
						: th.fg("warning", "modified");
			const p = th.fg("text", displayPath(e.path));
			const counts = e.binary
				? th.fg("dim", "(binary)")
				: th.fg("muted", `(+${e.added}/-${e.removed})`);
			const state = e.repoState ? " " + th.fg("dim", e.repoState) : "";
			const row = ` ${mark} ${kind} ${p} ${counts}${state}`;
			out.push(edge + " " + truncateToWidth(row, inner, "…"));
		}
		while (out.length < this.minRows()) out.push(filler);
		this.cacheLines = out;
		return out;
	}

	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheLines = [];
		this.cacheWidth = -1;
	}
	dispose(): void {}
}

// ─── header ──────────────────────────────────────────────────────────────────

/** One-row header: title + count + scope mode, dim ─ fill to width. */
class FilesHeader implements Component {
	constructor(private theme: Theme) {}
	render(width: number): string[] {
		const th = this.theme;
		const mode = tracker?.getMode() === "round" ? "round" : "all";
		const list = entries();
		let head =
			" " + th.fg("accent", "File Changes") + th.fg("dim", ` ${list.length} · ${mode}`) + " ";
		const fillW = Math.max(0, width - visibleWidth(head));
		return [head + th.fg("border", "─".repeat(fillW))];
	}
	invalidate(): void {}
	dispose(): void {}
}

// ─── section composition ─────────────────────────────────────────────────────

/**
 * Build the whole File Changes section: header + scrollable list + diff
 * subpanel, fitting `rows()` total rows. The diff subpanel gets 40% of the
 * section (min 3, max 60%); the list gets the rest.
 */
export function createFilesPanel(
	theme: Theme,
	rows: () => number,
	hook: () => void,
): Component {
	renderHook = hook;
	const total = () => Math.max(6, rows());
	const diffRows = () =>
		Math.max(3, Math.min(Math.round(total() * 0.4), total() - 4));
	const listRows = () => total() - 1 - diffRows(); // header + list + diff

	const listBody = new FilesListBody(theme, listRows);
	const scroll = new ScrollView(listBody, {
		follow: "none",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	// Click-to-select: rows are 1 visual row each, so y maps exactly.
	const clickable = new MouseRegion(scroll, (event: TuiMouseEvent) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const list = entries();
		if (list.length === 0) return { handled: true };
		const y = event.y - 0; // local to this region (the ScrollView)
		if (y < 0) return { handled: true };
		const idx = Math.round(scroll.scrollTop) + y;
		if (idx >= 0 && idx < list.length) {
			selectedPath = list[idx].absolutePath;
			filesVersion++;
			try {
				hook();
			} catch {
				/* ignore */
			}
		}
		return { handled: true };
	});

	return new MeasurementSafeVStack([
		{ component: new FilesHeader(theme), basis: 1, grow: 0, shrink: 0 },
		{
			component: clickable,
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		},
		// The diff subpanel is a FIXED row budget (40% of the section, min 3):
		// basis 0 / grow 0 would starve it to zero rows and let the list body
		// mis-allocate the section's bottom.
		{ component: new DiffBody(theme, diffRows), basis: diffRows(), grow: 0, shrink: 0 },
	]);
}

/** Default no-op factory: this module is shared, not an extension. */
export default function (_pi: ExtensionAPI): void {
	/* no-op: shared files-panel module */
}
