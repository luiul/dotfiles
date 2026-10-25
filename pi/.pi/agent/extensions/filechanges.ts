/**
 * filechanges.ts — the file-changes Panel and the /filechanges* commands
 * (presentation only).
 *
 * Tracking lives in filechanges-tracker.ts: the shared per-session state
 * (Session set, Round, Mode, Originals, Repo state, persistence, and the six
 * pi event subscriptions that drive it). This module's header in that file
 * explains the sharing, session keying, and /reload continuity. Vocabulary:
 * docs/filechanges-design.md.
 *
 * This extension renders the tracker's state two ways:
 * - Panel: a persistent widget above the editor ("filechanges"), live on
 *   every tracker state change (via subscribe). It shows the Mode's scope:
 *   the Round by default, the whole Session set in all mode. The header is
 *   bold and carries the scope's totals: `Changes last round (N): +A/-R`
 *   (totals hidden when both sides are zero, e.g. binary-only). One row per
 *   Change, most recently touched first, carrying its Repo state word after
 *   the counts when the file is in a git repo, capped at 8 rows plus one
 *   trailing line (pi truncates widgets past 10 lines). The trailing line is
 *   the overflow when there is one, else a pointer to the Changes the Round
 *   hides. Hidden when the Session set is empty; an empty Round with a
 *   non-empty Session set shows a one-line hint instead.
 * - Framing: every Panel line is prefixed with a dim left gutter (`│ `),
 *   quote-block style. The continuous bar separates the Panel from the
 *   transcript above it without adding emphasis (no background) or spending
 *   any of the 10 widget lines. Panel only: the List is requested
 *   transcript output and stays unframed.
 * - Colors are semantic, from the pi theme: the kind word by meaning
 *   (created = success, modified = warning, deleted = error), the path in
 *   text, counts in toolDiffAdded/toolDiffRemoved with zero counts dimmed,
 *   `(binary)` muted, and the Repo state word as quiet metadata (staged =
 *   accent, committed = dim, untracked = muted, unstaged = muted, conflicted
 *   = error, the only state red is spent on). The same scheme renders in
 *   the Panel and the List. The no-UI fallback (console.log) stays plain.
 *
 * The tracker also exposes setWidgetSuppressed for another presentation.
 * That consumer can call tracker.setWidgetSuppressed(true) to hide this
 * Panel. Tracking keeps working, and nothing is shown twice.
 *
 * Commands:
 * - `/filechanges` prints the Mode's scope into the transcript (up to 30
 *   rows, then an overflow note). `/filechanges round` and `/filechanges all`
 *   print one scope once without changing the Mode.
 * - `/filechanges-mode` toggles the Mode; the choice persists across
 *   /reload.
 * - `/filechanges-clear` empties the Session set and the Round and forgets
 *   all Originals (all through the tracker). Tracking restarts from that
 *   point: a file edited again gets a fresh Original, so its counts are
 *   measured from the post-Clear state.
 *
 * On notification delivery: `ctx.ui.notify`/`setWidget` are fire-and-forget
 * in every mode. In the TUI they render directly; in RPC mode (e.g. an
 * editor integration) they're emitted as `extension_ui_request` events on
 * stdout, which the RPC client may render or silently ignore per the pi RPC
 * spec. There's no extension-side way to guarantee a specific RPC client
 * surfaces them. If changes aren't visible in your editor, check whether its
 * pi integration handles `notify`/`setWidget` extension UI requests.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSharedFileChangesTracker, KIND_COLORS, REPO_STATE_COLORS } from "./filechanges-tracker.ts";
import type { FileChange, Mode } from "./filechanges-tracker.ts";

// Test seam: moved to the tracker module (where the tmp filtering lives);
// re-exported so the existing test script's import keeps working.
export { __setTmpRootsForTest } from "./filechanges-tracker.ts";

const PANEL_MAX_ROWS = 8;
const LIST_MAX_ROWS = 30;

function countsText(t: FileChange): string {
	return t.binary ? "(binary)" : `(+${t.added}/-${t.removed})`;
}

/**
 * Kind and Repo-state color keys live in filechanges-tracker.ts (KIND_COLORS,
 * REPO_STATE_COLORS, exported there so every consumer renders identical
 * hues): color does the scannability job glyphs would, so the words stay
 * plain, and the state axis stays quiet metadata so it cannot clash with
 * the kind hues on the same row (staged = accent, committed = dim,
 * untracked/unstaged = muted, conflicted = the only state red is spent on).
 */

/**
 * Panel framing: a dim left gutter (`│ `) on every line, quote-block style.
 * The continuous bar separates the Panel from the transcript above it
 * without adding emphasis (no background) or spending widget lines. Panel
 * only: the List is requested transcript output and stays unframed.
 */
function withGutter(lines: string[], theme?: any): string[] {
	const gutter = theme ? theme.fg("dim", "│ ") : "│ ";
	return lines.map((line) => gutter + line);
}

/** Shared row renderer, used by the Panel and by `/filechanges`. Plain words, no glyphs; color carries the meaning. */
function formatChangeLine(t: FileChange, theme?: any): string {
	const label = t.kind.padEnd(9); // "modified" is the longest kind at 8 chars
	if (!theme) return `${label}${t.path} ${countsText(t)}${t.repoState ? ` ${t.repoState}` : ""}`;
	const prefix = theme.fg(KIND_COLORS[t.kind], label) + theme.fg("text", `${t.path} `);
	let counts: string;
	if (t.binary) {
		counts = theme.fg("muted", "(binary)");
	} else {
		const plus = t.added === 0 ? theme.fg("dim", `+${t.added}`) : theme.fg("toolDiffAdded", `+${t.added}`);
		const minus = t.removed === 0 ? theme.fg("dim", `-${t.removed}`) : theme.fg("toolDiffRemoved", `-${t.removed}`);
		counts = theme.fg("dim", "(") + plus + theme.fg("dim", "/") + minus + theme.fg("dim", ")");
	}
	const state = t.repoState ? " " + theme.fg(REPO_STATE_COLORS[t.repoState], t.repoState) : "";
	return prefix + counts + state;
}

/** Line-count totals over one scope. Binary rows carry no counts and add nothing. */
function totalsOf(items: FileChange[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const t of items) {
		if (t.binary) continue;
		added += t.added;
		removed += t.removed;
	}
	return { added, removed };
}

/**
 * Panel/List header for one scope: bold label plus the scope's totals, e.g.
 * `Changes last round (3): +45/-12`. Round is the default view; "all" is the
 * whole Session set. Totals are hidden when both sides are zero (binary-only
 * scopes), leaving a bare `Changes last round (N):`.
 */
function formatHeader(mode: Mode, items: FileChange[], theme?: any): string {
	const base = mode === "round" ? `Changes last round (${items.length}):` : `Session changes (${items.length}):`;
	const { added, removed } = totalsOf(items);
	if (added === 0 && removed === 0) return theme ? theme.bold(base) : base;
	if (!theme) return `${base} +${added}/-${removed}`;
	const plus = added === 0 ? theme.fg("dim", `+${added}`) : theme.fg("toolDiffAdded", `+${added}`);
	const minus = removed === 0 ? theme.fg("dim", `-${removed}`) : theme.fg("toolDiffRemoved", `-${removed}`);
	return theme.bold(base) + " " + plus + theme.fg("dim", "/") + minus;
}

/**
 * Panel content for one scope: header, up to PANEL_MAX_ROWS rows, and at most
 * one trailing line (10 lines total, pi's widget limit). The trailing line is
 * the overflow when there is one, else a pointer to the Changes the Round
 * hides. Empty Round with a non-empty Session set: a one-line hint. Every
 * line is framed with the gutter.
 */
function buildPanelLines(items: FileChange[], sessionSize: number, mode: Mode, theme?: any): string[] | undefined {
	if (items.length === 0) {
		if (sessionSize === 0 || mode === "all") return undefined;
		const hint = `No changes last round (${sessionSize} this session): /filechanges-mode`;
		return withGutter([theme ? theme.fg("muted", hint) : hint], theme);
	}
	const lines: string[] = [formatHeader(mode, items, theme)];

	const shown = items.slice(0, PANEL_MAX_ROWS);
	for (const t of shown) lines.push(formatChangeLine(t, theme));
	if (items.length > shown.length) {
		const more = `…and ${items.length - shown.length} more (see /filechanges)`;
		lines.push(theme ? theme.fg("dim", more) : more);
	} else if (mode === "round" && sessionSize > items.length) {
		const more = `…and ${sessionSize - items.length} more this session (see /filechanges-mode)`;
		lines.push(theme ? theme.fg("dim", more) : more);
	}
	return withGutter(lines, theme);
}

export default function (pi: ExtensionAPI) {
	// The session's one tracker. Created eagerly at factory time (before any
	// event) so its six event subscriptions are wired before the first
	// session_start/tool_call; binds to the session key on its first event.
	const tracker = getSharedFileChangesTracker(pi);

	/**
	 * Paint the Panel from the tracker's current state. Called on every
	 * tracker state change (subscribe) and from the commands with their own
	 * ctx. While the tracker is widget-suppressed (a consumer owns
	 * presentation), the Panel is cleared and not rendered.
	 */
	function refreshWidget(ctx?: ExtensionContext) {
		const c = ctx ?? tracker.getContext();
		if (!c?.hasUI) return;
		if (tracker.isWidgetSuppressed()) {
			c.ui.setWidget("filechanges", undefined);
			return;
		}
		const items = tracker.getChanges();
		const sessionSize = tracker.getChanges("all").length;
		c.ui.setWidget("filechanges", buildPanelLines(items, sessionSize, tracker.getMode(), c.ui.theme));
	}

	tracker.subscribe(() => refreshWidget());

	/** `/filechanges`: print one scope into the transcript, colored like the Panel. A `round`/`all` arg picks a scope once without changing the Mode. */
	function listSessionSet(ctx: ExtensionContext, args: string) {
		const arg = args.trim();
		const view: Mode = arg === "all" || arg === "round" ? arg : tracker.getMode();
		const items = tracker.getChanges(view);
		const sessionSize = tracker.getChanges("all").length;
		if (items.length === 0) {
			const msg =
				view === "round" && sessionSize > 0
					? `filechanges: no changes last round (${sessionSize} this session: /filechanges-mode).`
					: "filechanges: no files changed this session.";
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(`[filechanges] ${msg}`);
			return;
		}
		const theme = ctx.hasUI ? ctx.ui.theme : undefined;
		const shown = items.slice(0, LIST_MAX_ROWS);
		const lines = [formatHeader(view, items, theme), ...shown.map((t) => formatChangeLine(t, theme))];
		if (items.length > shown.length) {
			const more = `  …and ${items.length - shown.length} more`;
			lines.push(theme ? theme.fg("dim", more) : more);
		} else if (view === "round" && sessionSize > items.length) {
			const more = `  …and ${sessionSize - items.length} more this session (see /filechanges-mode)`;
			lines.push(theme ? theme.fg("dim", more) : more);
		}
		const body = lines.join("\n");
		if (ctx.hasUI) ctx.ui.notify(body, "info");
		else console.log(`[filechanges] ${body}`);
	}

	pi.registerCommand("filechanges", {
		description: "List changed files for the current view (append 'round' or 'all' to pick a view once)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			// Refresh first so the List always prints current git state, even if it moved outside pi.
			await tracker.refreshRepoStates(ctx);
			refreshWidget(ctx);
			listSessionSet(ctx, args);
		},
	});

	pi.registerCommand("filechanges-mode", {
		description: "Toggle the filechanges view between the last round and all session changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			tracker.setMode(tracker.getMode() === "round" ? "all" : "round");
			refreshWidget(ctx);
			const msg = tracker.getMode() === "round" ? "filechanges: showing changes last round." : "filechanges: showing all session changes.";
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(`[filechanges] ${msg}`);
		},
	});

	pi.registerCommand("filechanges-clear", {
		description: "Clear the session change list and restart tracking",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			tracker.clear();
			refreshWidget(ctx);
			if (ctx.hasUI) ctx.ui.notify("filechanges: cleared. Tracking restarts from the next change.", "info");
			else console.log("[filechanges] cleared.");
		},
	});
}
