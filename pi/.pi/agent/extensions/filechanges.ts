/** Persistent cumulative file changes, with full detail on demand. Uses only public Pi UI APIs. */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import { getSharedFileChangesTracker, KIND_COLORS, REPO_STATE_COLORS } from "./filechanges-tracker.ts";
import type { FileChange } from "./filechanges-tracker.ts";
export { __setTmpRootsForTest } from "./filechanges-tracker.ts";

const PANEL_ROWS = 6;
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

/** File names must never inject terminal control sequences or extra Panel rows. */
export function displayPath(path: string): string {
	return stripTerminalSequences(path).replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => {
		const escaped = JSON.stringify(c).slice(1, -1);
		return escaped === c ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : escaped;
	});
}

export function shortenPath(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	if (width === 1) return "…";
	return "…" + sliceByColumn(path, visibleWidth(path) - width + 1, width - 1, true);
}

function counts(item: FileChange, theme: Theme): string {
	if (item.binary) return theme.fg("muted", "(binary)");
	return theme.fg(item.added ? "toolDiffAdded" : "dim", `+${item.added}`) + theme.fg("dim", "/") +
		theme.fg(item.removed ? "toolDiffRemoved" : "dim", `-${item.removed}`);
}

function summary(items: readonly FileChange[], theme: Theme, width: number): string {
	let added = 0, removed = 0, active = 0;
	for (const item of items) {
		if (!item.binary) { added += item.added; removed += item.removed; }
		if (item.touchedThisPrompt) active++;
	}
	const title = theme.bold(`Session changes: ${items.length} ${items.length === 1 ? "file" : "files"}`);
	const totals = added || removed ? "  " + counts({ added, removed } as FileChange, theme) : "";
	const activity = active ? theme.fg("muted", `  ·  ${active} this prompt`) : "";
	return truncateToWidth(title + totals + activity, width);
}

interface PreparedRow {
	path: string;
	pathWidth: number;
	minimumPath: number;
	label: string;
	delta: string;
	deltaWidth: number;
	state: string;
	stateWidth: number;
	conflicted: boolean;
	activity: string;
	activityWidth: number;
}

function prepareRow(item: FileChange, theme: Theme): PreparedRow {
	const path = displayPath(item.path);
	return {
		path, pathWidth: visibleWidth(path), minimumPath: Math.min(visibleWidth(path), Math.max(12, visibleWidth(path.split("/").pop() ?? ""))),
		label: theme.fg(KIND_COLORS[item.kind], item.kind.padEnd(9)),
		delta: " " + counts(item, theme), deltaWidth: visibleWidth(item.binary ? " (binary)" : ` +${item.added}/-${item.removed}`),
		state: item.repoState ? " " + theme.fg(REPO_STATE_COLORS[item.repoState], item.repoState) : "",
		stateWidth: item.repoState ? item.repoState.length + 1 : 0, conflicted: item.repoState === "conflicted",
		activity: item.touchedThisPrompt ? theme.fg("muted", "  this prompt") : "", activityWidth: item.touchedThisPrompt ? 13 : 0,
	};
}

function renderRow(row: PreparedRow, width: number, theme: Theme): string {
	let stateWidth = row.stateWidth, activityWidth = row.activityWidth;
	const budget = () => width - 9 - row.deltaWidth - stateWidth - activityWidth;
	if (budget() < row.minimumPath && !row.conflicted) stateWidth = 0;
	if (budget() < row.minimumPath) activityWidth = 0;
	const pathWidth = Math.max(0, budget());
	const path = row.pathWidth <= pathWidth ? row.path : pathWidth <= 0 ? "" :
		pathWidth === 1 ? "…" : "…" + sliceByColumn(row.path, row.pathWidth - pathWidth + 1, pathWidth - 1, true);
	const line = row.label + theme.fg("text", path) + row.delta + (stateWidth ? row.state : "") + (activityWidth ? row.activity : "");
	return width < 9 + row.deltaWidth + stateWidth + activityWidth ? truncateToWidth(line, width) : line;
}

/** Reserve metadata space before shortening the path, never wrap a Panel row. */
export function formatPanelRow(item: FileChange, width: number, theme: Theme): string {
	return renderRow(prepareRow(item, theme), width, theme);
}

/** One session-owned widget. Cached rows have no file reads, Git calls, or sorting. */
export class FileChangesPanel {
	private items: readonly FileChange[];
	private cachedWidth = -1;
	private cachedColors: unknown;
	private cachedLines: string[] | undefined;
	private preparedItems: readonly FileChange[] | undefined;
	private preparedColors: unknown;
	private rows: PreparedRow[] = [];
	constructor(items: readonly FileChange[], private theme: Theme) { this.items = items; }
	setItems(items: readonly FileChange[]): boolean {
		if (items === this.items) return false;
		this.items = items;
		this.cachedLines = undefined;
		return true;
	}
	// Pi can invalidate the whole tree on unrelated events. All layout inputs are
	// checked in render(), so unchanged immutable state keeps its cached rows.
	invalidate(): void {}
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.cachedColors === this.theme.colors) return this.cachedLines;
		if (this.preparedItems !== this.items || this.preparedColors !== this.theme.colors) {
			this.rows = this.items.slice(0, PANEL_ROWS).map((item) => prepareRow(item, this.theme));
			this.preparedItems = this.items;
			this.preparedColors = this.theme.colors;
		}
		const gutter = this.theme.fg("dim", "│ ");
		const budget = Math.max(0, width - 2);
		const lines = this.items.length ? [summary(this.items, this.theme, budget),
			...this.rows.map((row) => renderRow(row, budget, this.theme))] : [];
		if (this.items.length > PANEL_ROWS) lines.push(truncateToWidth(this.theme.fg("dim", `${this.items.length - PANEL_ROWS} more · /filechanges`), budget));
		this.cachedWidth = width;
		this.cachedColors = this.theme.colors;
		return this.cachedLines = width < 2 ? lines.map(() => width > 0 ? this.theme.fg("dim", "│") : "") : lines.map((line) => gutter + line);
	}
}

/** Full paths wrap in the requested List. ScrollView owns scroll state, without timers. */
export class FileChangesList {
	private scroll: ScrollView;
	private body = new Container();
	private colors: unknown;
	private cachedHeader: string | undefined;
	private cachedHeaderWidth = -1;
	private cachedHeaderColors: unknown;
	constructor(private items: readonly FileChange[], private theme: Theme, private tui: any,
		private keybindings: any, private done: () => void) {
		this.scroll = new ScrollView(this.body, { follow: "none", scrollbar: "hidden", overscroll: "contain" });
		this.rebuild();
	}
	private rebuild(): void {
		const theme = this.theme;
		this.body.clear();
		for (const item of this.items) {
			const state = item.repoState ? " " + theme.fg(REPO_STATE_COLORS[item.repoState], item.repoState) : "";
			const activity = item.touchedThisPrompt ? theme.fg("muted", "  this prompt") : "";
			this.body.addChild(new Text(theme.fg(KIND_COLORS[item.kind], item.kind.padEnd(9)) + theme.fg("text", displayPath(item.path)) +
				" " + counts(item, theme) + state + activity, 0, 0));
		}
		this.colors = theme.colors;
	}
	invalidate(): void { this.colors = undefined; this.cachedHeader = undefined; this.scroll.invalidate(); }
	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.colors !== this.theme.colors) this.rebuild();
		const lines = this.scroll.render(Math.max(1, width));
		if (this.cachedHeader === undefined || this.cachedHeaderWidth !== width || this.cachedHeaderColors !== this.theme.colors) {
			this.cachedHeader = summary(this.items, this.theme, width);
			this.cachedHeaderWidth = width;
			this.cachedHeaderColors = this.theme.colors;
		}
		const header = this.cachedHeader;
		const height = Math.max(1, (this.tui.terminal?.rows ?? 24) - 8);
		this.scroll.updateLayout(lines.length, height, () => this.tui.requestRender());
		const top = this.scroll.scrollTop;
		return [header, ...lines.slice(top, top + height),
			truncateToWidth(this.theme.fg("dim", `${top + 1}–${Math.min(top + height, lines.length)}/${lines.length} lines · ↑↓ PgUp/PgDn Home/End · Escape closes`), width)];
	}
	handleInput(data: string): void {
		const match = (action: string, key: KeyId) => this.keybindings?.matches(data, action) || matchesKey(data, key);
		if (match("tui.select.cancel", "escape") || matchesKey(data, "ctrl+c")) { this.done(); return; }
		if (match("tui.select.up", "up")) this.scroll.scrollBy(-1);
		else if (match("tui.select.down", "down")) this.scroll.scrollBy(1);
		else if (match("tui.select.pageUp", "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (match("tui.select.pageDown", "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else return;
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI) {
	const tracker = getSharedFileChangesTracker(pi);
	let panel: FileChangesPanel | undefined;
	let requestRender: (() => void) | undefined;
	let visible = false;
	let listDepth = 0;
	let active = true;
	function refreshWidget() {
		const ctx = tracker.getContext();
		if (!active || ctx?.mode !== "tui" || !ctx.hasUI) return;
		const items = tracker.getChanges();
		if (listDepth > 0 || !items.length) {
			if (visible) ctx.ui.setWidget("filechanges", undefined);
			panel = undefined; requestRender = undefined; visible = false;
		} else if (!visible) {
			visible = true;
			ctx.ui.setWidget("filechanges", (tui, theme) => {
				panel = new FileChangesPanel(items, theme);
				requestRender = () => tui.requestRender();
				return panel;
			});
		} else if (panel?.setItems(items)) requestRender?.();
	}
	const unsubscribe = tracker.subscribe(refreshWidget);
	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		unsubscribe();
		if (ctx.mode === "tui" && visible) ctx.ui.setWidget("filechanges", undefined);
		panel = undefined; requestRender = undefined; visible = false;
	});
	function validArgs(args: string, ctx: ExtensionContext, command: string): boolean {
		if (!args.trim()) return true;
		ctx.ui.notify(`Usage: /${command} (no arguments). Filechanges always shows session changes.`, "info");
		return false;
	}
	pi.registerCommand("filechanges", {
		description: "Show all session file changes in a scrollable list",
		handler: async (args, ctx) => {
			if (!validArgs(args, ctx, "filechanges")) return;
			await ctx.waitForIdle();
			await tracker.refreshRepoStates(ctx);
			refreshWidget();
			const items = tracker.getChanges();
			if (ctx.mode !== "tui" || !ctx.hasUI || !items.length) {
				const text = items.length ? [summary(items, plainTheme, 10000), ...items.map((item) =>
					`${item.kind} ${displayPath(item.path)} ${item.binary ? "(binary)" : `+${item.added}/-${item.removed}`}${item.repoState ? ` ${item.repoState}` : ""}`)].join("\n") : "filechanges: no files changed this session.";
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
				return;
			}
			listDepth++;
			refreshWidget();
			try {
				await ctx.ui.custom<void>((tui, theme, keybindings, done) => new FileChangesList(items, theme, tui, keybindings, done), {
					overlay: true,
					overlayOptions: { anchor: "center", width: "100%", margin: { top: 2, bottom: 2 } },
				});
			} finally {
				listDepth--;
				refreshWidget();
			}
		},
	});
	pi.registerCommand("filechanges-clear", {
		description: "Clear tracking and start fresh, without changing files",
		handler: async (args, ctx) => {
			if (!validArgs(args, ctx, "filechanges-clear")) return;
			await ctx.waitForIdle();
			tracker.clear();
		},
	});
}
