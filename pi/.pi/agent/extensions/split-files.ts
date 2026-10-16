/**
 * split-files.ts — the File Changes panel for the split extension's right
 * column. Renders the shared tracker from filechanges-tracker.ts (the same
 * tracking state as the filechanges.ts above-editor widget) as a scrollable
 * list.
 *
 * Layout inside the section's row budget:
 *
 *     File Changes (7 · round) ───────   ← 1-row header (count + mode)
 *     │ modified src/a.ts (+12/-3)      ← list, one visual row per entry
 *     │ created  b.md (+8) staged
 *
 * - List entries wrap for readability: a path that does not fit one row
 *   wraps with a hanging indent aligned under the kind word, never
 *   truncated. Entries render NEWEST-FIRST (the tracker's order, same as
 *   the /filechanges widget), so the list does not follow the end: the
 *   viewport stays at the top where the newest change lands.
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
import {
	ScrollView,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import {
	getSharedFileChangesTracker,
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
 * The changes list: NEWEST-FIRST (the tracker's order, same as the
 * filechanges widget). The ScrollView does not follow the end — the top of
 * the list is the newest change, which is where the eye goes. Rows carry the
 * same semantic colors as the filechanges widget: kind word colored, path
 * plain, +A/-R in diff colors, repo state as quiet metadata.
 *
 * Readability (user decision 2026-10-16): paths are never truncated. An
 * entry that does not fit one row WRAPS with a hanging indent aligned under
 * the kind word, and the counts/state suffix lands on the last wrapped
 * line. So a full entry is scannable regardless of path length.
 */
class FilesListBody implements Component {
	private cacheVersion = -1;
	private cacheWidth = -1;
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Rows to guarantee so the left │ edge stays continuous (viewport height). */
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
			this.cacheLines = out;
			return out;
		}
		for (const e of list) {
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
			const prefix = " " + kind;
			const suffix = ` ${counts}${state}`;
			const lead = visibleWidth(prefix);
			// One leading space after the edge, then prefix + path + suffix.
			const avail = inner - 1;
			const pathW = Math.max(8, avail - lead - visibleWidth(suffix));
			if (visibleWidth(p) <= pathW) {
				out.push(edge + prefix + p + suffix);
			} else {
				// Wrap the path: continuation lines are indented to align under
				// the kind word; the suffix rides the last line.
				const wrapped = wrapTextWithAnsi(p, pathW);
				for (let i = 0; i < wrapped.length; i++) {
					const head = i === 0 ? prefix : " ".repeat(lead);
					const tail = i === wrapped.length - 1 ? suffix : "";
					out.push(edge + head + wrapped[i] + tail);
				}
			}
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
