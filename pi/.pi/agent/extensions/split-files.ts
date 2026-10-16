/**
 * split-files.ts — the File Changes panel for the split extension's right
 * column. Renders the shared tracker from filechanges-tracker.ts (the same
 * tracking state as the filechanges.ts above-editor widget) as a scrollable
 * list.
 *
 * Layout inside the section's row budget:
 *
 *     File Changes (7 · round) ───────   ← 1-row header (count + mode)
 *     created  src/a.ts (+12/-3) staged  ← list, one visual row per entry
 *     modified b.md (+8) unstaged
 *
 * - Rows mirror the /filechanges widget (formatChangeLine): the kind word
 *   padded to 9 columns and colored by meaning, the path in text, counts
 *   in diff colors, the repo state as quiet metadata. No left rail inside
 *   the panel (the section divider is the rail; a second one rendered as a
 *   confusing double bar `││`).
 * - Legibility contract (fixed 2026-10-16 after a live report of
 *   8-character path fragments and `untrac`-style edge clipping): rows are
 *   composed from plain pieces, measured, and colored last, so no row can
 *   overflow the section width. A path that does not fit one row wraps at
 *   "/" boundaries with a hanging indent under the kind word. The
 *   counts+state suffix rides the last wrapped line while it would leave
 *   at least half the row for the path; on a narrow panel it moves to its
 *   own indented line, and the repo-state word is dropped before the
 *   counts are ever squeezed. Entries render NEWEST-FIRST (the tracker's
 *   order, same as the /filechanges widget), so the list does not follow
 *   the end: the viewport stays at the top where the newest change lands.
 * - Round/all scope follows the tracker's mode (shared with /filechanges-mode,
 *   /filechanges): the panel and the old widget are two views of one state.
 * - While this panel is active, split.ts suppresses the filechanges.ts widget
 *   via the same tracker (nothing is shown twice). This module owns that
 *   suppression call on split's behalf (setFilesSuppressed).
 *
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { ScrollView, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	getSharedFileChangesTracker,
	KIND_COLORS,
	REPO_STATE_COLORS,
	type FileChange,
	type FileChangesTracker,
} from "./filechanges-tracker.ts";
import { MeasurementSafeVStack } from "./split-render.ts";

// ─── module state (single-session-per-process assumption) ────────────────────

let tracker: FileChangesTracker | null = null;
let unsubscribe: (() => void) | null = null;
/** Bumped on every tracker state change (drives the list cache key). */
let filesVersion = 0;
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

/** Short display path relative to cwd, else ~-relative, else absolute. */
function displayPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	const home = process.env.HOME ?? "";
	if (home && p.startsWith(home + "/")) return `~${p.slice(home.length)}`;
	return p;
}

// ─── list body ───────────────────────────────────────────────────────────────

/**
 * Greedy-wrap a path at "/" boundaries: a separator ends the segment it
 * belongs to, so lines break between path segments, never inside one (the
 * plain-text sibling of the widget's no-wrap rendering). A segment longer
 * than the width is hard-broken. Returns plain-text lines, each at most
 * `width` columns (path characters are single-column by nature).
 */
export function wrapPathSegments(p: string, width: number): string[] {
	if (width < 1) return [p];
	if (p.length <= width) return [p];
	const units: string[] = [];
	let i = 0;
	while (i < p.length) {
		const next = p.indexOf("/", i);
		const seg = next === -1 ? p.slice(i) : p.slice(i, next + 1);
		if (seg.length <= width) units.push(seg);
		else for (let j = 0; j < seg.length; j += width) units.push(seg.slice(j, j + width));
		if (next === -1) break;
		i = next + 1;
	}
	const lines: string[] = [];
	let cur = "";
	for (const u of units) {
		if (cur && cur.length + u.length > width) {
			lines.push(cur);
			cur = u;
		} else {
			cur += u;
		}
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [p];
}

/** Counts piece of a row, plain (for measuring) and colored (for output). */
function buildCounts(th: Theme, e: FileChange): { plain: string; colored: string } {
	if (e.binary) {
		const plain = "(binary)";
		return { plain, colored: th.fg("muted", plain) };
	}
	const plain = `(+${e.added}/-${e.removed})`;
	const plus = e.added === 0 ? th.fg("dim", `+${e.added}`) : th.fg("toolDiffAdded", `+${e.added}`);
	const minus = e.removed === 0 ? th.fg("dim", `-${e.removed}`) : th.fg("toolDiffRemoved", `-${e.removed}`);
	return {
		plain,
		colored: th.fg("dim", "(") + plus + th.fg("dim", "/") + minus + th.fg("dim", ")"),
	};
}

/**
 * Build the panel's list rows for one width. Pure except for theme colors,
 * and exported for unit tests. Rows render NEWEST-FIRST (the tracker's
 * order, same as the /filechanges widget) and mirror its formatChangeLine:
 * `<kind padded to 9> <path> (+A/-R) <state>` after the section divider.
 *
 * Legibility contract (user report 2026-10-16: the panel rendered 8-char
 * path fragments and clipped `untracked` mid-word at the panel edge):
 * - Rows are composed from plain pieces, measured, and colored last, so a
 *   row can never overflow the section width and get clipped mid-word at
 *   the panel edge.
 * - A path that does not fit one row wraps at "/" boundaries
 *   (wrapPathSegments) with a hanging indent under the kind word.
 * - The counts+state suffix rides the last wrapped line while that would
 *   leave at least half the row budget for the path. When the suffix is
 *   wider than that (narrow panels), it moves to its own indented line and
 *   the path wraps at the full row budget; the repo-state word is dropped
 *   before the counts are ever squeezed, and a pathological width
 *   ellipsizes the counts rather than clipping them.
 * - No left rail inside the panel: the section divider is the rail, and a
 *   second one rendered as a confusing double bar (`││`). Blank filler
 *   rows keep the section height stable instead.
 */
export function buildFilesRows(
	theme: Theme,
	list: FileChange[],
	width: number,
	minRows: number,
): string[] {
	const th = theme;
	const labelW = 9; // kind.padEnd(9): "modified" (8) is the longest kind word
	const indent = 1 + labelW; // 1 col after the divider + the label
	const budget = Math.max(1, width - indent); // columns for path + suffix
	const out: string[] = [];
	if (list.length === 0) {
		out.push(" " + th.fg("muted", "No changes yet"));
	}
	for (const e of list) {
		const label = e.kind.padEnd(labelW);
		const kind = th.fg(KIND_COLORS[e.kind], label);
		const head = " " + kind;
		const cont = " ".repeat(indent);
		const counts = buildCounts(th, e);
		const statePlain = e.repoState ?? "";
		const state = statePlain ? " " + th.fg(REPO_STATE_COLORS[e.repoState!], statePlain) : "";
		const suffix = " " + counts.colored + state;
		const sW = 1 + counts.plain.length + (statePlain ? 1 + statePlain.length : 0);
		const pathPlain = displayPath(e.path);
		const pW = visibleWidth(pathPlain);
		if (pW + sW <= budget) {
			// One row: the whole entry fits.
			out.push(head + th.fg("text", pathPlain) + suffix);
			continue;
		}
		// Suffix fits on its own line while leaving at least half the row for
		// the path; otherwise it gets its own line and the path wraps wide.
		const suffixFits = (withState: boolean) =>
			indent + counts.plain.length + (withState && statePlain ? 1 + statePlain.length : 0) <= width;
		const own = budget - sW < Math.ceil(budget / 2);
		const wrapW = own ? budget : budget - sW;
		const chunks = wrapPathSegments(pathPlain, wrapW);
		for (let i = 0; i < chunks.length; i++) {
			const tail = !own && i === chunks.length - 1 ? suffix : "";
			out.push((i === 0 ? head : cont) + th.fg("text", chunks[i]) + tail);
		}
		if (own) {
			// Own suffix line: counts align exactly under the path column (cont
			// already provides the leading space).
			if (suffixFits(true)) out.push(cont + counts.colored + state);
			else if (suffixFits(false)) out.push(cont + counts.colored);
			else out.push(cont + th.fg("muted", truncateToWidth(counts.plain, width - indent)));
		}
	}
	// Keep the section's row budget stable (blank rows; the scrollbar and
	// section height do not jump as entries wrap).
	while (out.length < minRows) out.push("");
	return out;
}

class FilesListBody implements Component {
	private cacheVersion = -1;
	private cacheWidth = -1;
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Rows to guarantee so the section height stays stable (viewport height). */
		private minRows: () => number = () => 1,
	) {}

	render(width: number): string[] {
		const v = filesVersion;
		if (v !== this.cacheVersion) {
			this.cacheVersion = v;
			this.cacheLines = [];
		}
		if (this.cacheLines.length && this.cacheWidth === width) return this.cacheLines;
		this.cacheWidth = width;
		this.cacheLines = buildFilesRows(this.theme, entries(), width, this.minRows());
		return this.cacheLines;
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
 * Build the whole File Changes section: 1-row header + scrollable list
 * filling the rest of the section's row budget.
 */
export function createFilesPanel(
	theme: Theme,
	rows: () => number,
	hook: () => void,
): Component {
	renderHook = hook;
	const listRows = () => Math.max(1, rows() - 1); // header + list

	const listBody = new FilesListBody(theme, listRows);
	const scroll = new ScrollView(listBody, {
		follow: "none",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});

	return new MeasurementSafeVStack([
		{ component: new FilesHeader(theme), basis: 1, grow: 0, shrink: 0 },
		{
			component: scroll,
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		},
	]);
}

/** Default no-op factory: this module is shared, not an extension. */
export default function (_pi: ExtensionAPI): void {
	/* no-op: shared files-panel module */
}
