/**
 * split.ts — one adjustable vertical split for the pi fullscreen TUI.
 *
 *   ┌ left column (drag the divider or /split-width) ┐┌ right column ┐
 *   │ ▌ pinned user prompt (split-sticky.ts)     ││ Thinking     │
 *   │ ───────────────────────                        ││ Tools        │
 *   │ transcript (full, or response-only via           ││ File Changes │
 *   │ /split-toggle-response-only)                   ││              │
 *   │ > input dock (pi's own, reused verbatim)      ││              │
 *   └──────────────────────────────────────────────────┘└──────────────┘
 *
 * - One vertical split, adjustable: mouse-drag the 1-col divider (blank
 *   at rest, accent | while dragging; press captures the drag; move updates
 *   the left share 20–80%), or /split-width <pct>. Session-local; /split-save
 *   persists it.
 * - Left: pi's base root verbatim (transcript + input dock), or the
 *   response-only view from split-response.ts (transcript region swapped,
 *   input dock reused). Above the transcript: the sticky user prompt bar
 *   from split-sticky.ts (/split-toggle-sticky, on by default) pins the user
 *   prompt that owns the top visible line while it is scrolled above the
 *   view (VS Code sticky scroll).
 * - Right: three compact stacked panels — thinking (split-panels.ts), tool
 *   usage (split-panels.ts), file changes (split-files.ts, driven by the
 *   shared tracker from filechanges-tracker.ts — the same data as the
 *   /filechanges widget, which hides while this panel is on). Row shares
 *   default 30/25/45 with files biggest (user decision 2026-10-16);
 *   adjustable via /split-*-height.
 * - Dividers are minimal: no box borders, 1-row compact headers that double
 *   as separators, the ScrollView track is each panel's right frame edge.
 * - Fullscreen only. In regular mode the extension stays dormant and /split-toggle
 *   says so. Below MIN_TERM_WIDTH the right column hides (left keeps growing).
 *   /split-toggle-right hides or shows the whole right column at once; the hidden
 *   panel set is remembered, so a re-show restores it exactly. Hiding keeps
 *   the left column clean: the filechanges widget stays suppressed while the
 *   hidden set includes the files panel.
 * - Update notices (split-updates.ts): pi's "Update Available" and "Package
 *   Updates Available" startup blocks, its [Skill conflicts] block, and its
 *   post-update "What's New" changelog block, are transcript-only with no
 *   extension event, so the extension re-runs the checks/scans through
 *   pi's public API and mirrors the results through
 *   three surfaces: Tools panel event rows, a framed block at the doc top in
 *   response-only mode (re-appended after every rebuild), and a persistent
 *   footer status line — the one surface visible in every layout state. No
 *   layout state drops them. The changelog notice is condensed (pi's full
 *   block stays reachable via the transcript toggle in that session) and
 *   detects the update from settings.lastChangelogVersion captured at module
 *   import — pi consumes the marker during init(), before session_start.
 *   Session start only; --split-fake-updates forces
 *   fixture notices for tests. /split-changelog appends the running
 *   version's full changelog entry as a doc-bottom block on demand (pi's
 *   /changelog output is transcript-only, so response-only mode would
 *   otherwise show nothing when the user asks for it).
 * - Toggles are session-local; only /split-save writes ~/.pi/agent/split.json
 *   as startup defaults for NEW windows. --no-split starts bare.
 *
 * Layout ownership: the composition registers as ONE layer in split-layout.ts
 * (the shared owner of pi's single layout-root slot), so it never fights
 * other extensions over the root, and /reload unwraps stale compositions.
 *
 * Single-TUI-context assumption (inherited from upstream SV-20): one
 * interactive TUI context per process. Module state is a singleton.
 */

import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { HStack, type Component } from "@earendil-works/pi-tui";
import {
	loadSplitConfig,
	normalizeConfig,
	normalizeRightPcts,
	saveSplitConfig,
	type NormalizedSplitConfig,
} from "./split-config.ts";
import {
	DragDivider,
	getBaseRoot,
	initLayoutManager,
	isLayoutLayerActive,
	resetLayoutManager,
	selfHealLayout,
	setLayoutLayer,
} from "./split-layout.ts";
import { MeasurementSafeVStack, framedPanel } from "./split-render.ts";
import {
	setPanelRenderHook,
	thinkingPanel,
	toolsPanel,
} from "./split-panels.ts";
import {
	appendUpdateNoticesToDoc,
	baseDockOf,
	buildResponseInner,
	getResponseDoc,
	getResponseScrollView,
	rebuildResponseDoc,
	resetResponseState,
	responseDocBegin,
	responseDocEnd,
	responseIngestEntry,
	responseMessageEnd,
	responseMessageStart,
	responseMessageUpdate,
	setResponseTheme,
	setResponseTui,
	startLiveBash,
	syncBranchEntries,
} from "./split-response.ts";
import { initStatusMirror, pollStatusLines, resetStatusMirror } from "./split-status.ts";
import { StickyPromptBar, findTranscriptScrollView } from "./split-sticky.ts";
import { createFilesPanel, disposeFilesPanel, initFilesPanel, setFilesSuppressed } from "./split-files.ts";
import {
	CHANGELOG_URL,
	ONDEMAND_CHANGELOG_PREFIX,
	buildOndemandChangelogNotice,
	collectStartupNotices,
	fakeUpdateNotices,
	getActiveNotices,
	noticeBodyText,
	noticesStatusText,
	readCurrentVersionEntry,
	resetUpdateNotices,
	setUpdateNotices,
} from "./split-updates.ts";

const WIDGET_KEY = "split";
const LAYER_ID = "split";
/** Below this terminal width the right column (and divider) hide. */
const MIN_TERM_WIDTH = 90;
/** Minimum columns/rows a side/panel keeps before clamping. */
const MIN_SIDE_COLS = 30;
const MIN_SECTION_ROWS = 4;

// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: any;
let widgetSet = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** Deferred startup update-check timer (split-updates.ts; cleared on shutdown). */
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
/** Clear timer for the transient "left: response only|full transcript" status
 * hint; cancelled on re-toggle so the new hint always gets its full 4s. */
let trimHintTimer: ReturnType<typeof setTimeout> | null = null;
/** The saved startup composition is still unapplied; consumed by the widget
 * factory (first point where the fullscreen root exists, before first paint)
 * or by the deferred startup timer as a fallback (upstream SV-14 pattern). */
let startupPending = false;

// Generation guard: survives /reload, lets stale deferred callbacks no-op.
const REG_KEY = Symbol.for("pi.split");
interface Registry {
	gen: number;
}
const G = globalThis as Record<symbol, Registry>;
const REG: Registry = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

// Panel flags (session-local; defaults come from the saved config).
let thinkingOn = false;
let toolsOn = false;
let filesOn = false;
/** Snapshot of the three right-panel flags taken when /split-toggle-right hides
 * the column, so the re-show restores the exact panel set. Session-local. */
let rightHiddenSnapshot: { thinking: boolean; tools: boolean; files: boolean } | null =
	null;
let trimResponse = false;
/** Sticky user prompt bar at the top of the left column (split-sticky.ts). */
let stickyOn = false;
/** Live bar instance; recreated on recompose, heights shared via WeakMap. */
let stickyBar: StickyPromptBar | null = null;
let toolMode: "compact" | "full" = "compact";
/** LEFT (transcript) column share of usable width in percent, 20–80. */
let leftWidthPct = 60;
/** Right column row shares in percent; files biggest by default. */
let thinkingPct = 30;
let toolsPct = 25;
let filesPct = 45;

/** Fingerprint of the composition's theme + geometry, for change detection
 * in the widget render loop (pi gives no theme event; it swaps the theme
 * object — upstream SV-08 pattern). */
let composedThemeFp: string | null = null;
let composedCols = -1;
let composedRows = -1;

function themeFingerprint(theme: Theme): string {
	return [
		theme.fg("border", "x"),
		theme.fg("accent", "x"),
		theme.fg("muted", "x"),
		theme.fg("thinkingText", "x"),
		theme.fg("toolOutput", "x"),
		theme.fg("success", "x"),
		theme.fg("error", "x"),
		theme.fg("warning", "x"),
		theme.fg("dim", "x"),
		theme.fg("text", "x"),
	].join("|");
}

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () => isLayoutLayerActive(LAYER_ID);
const rightColumnWanted = () => thinkingOn || toolsOn || filesOn;
const anyFlagOn = () => thinkingOn || toolsOn || filesOn || trimResponse || stickyOn;

// ─── sticky bar source ───────────────────────────────────────────────────────

/** Live {sv, doc} for the sticky bar: the response view in trim mode, pi's
 * transcript ScrollView + document container otherwise. */
function stickySource(): { sv: unknown; doc: unknown } | null {
	if (trimResponse) {
		const sv = getResponseScrollView();
		return sv ? { sv, doc: getResponseDoc() } : null;
	}
	const base = getBaseRoot();
	if (!base) return null;
	const sv = findTranscriptScrollView(base);
	const doc = (sv as any)?.child;
	return sv && doc ? { sv, doc } : null;
}

// ─── geometry ────────────────────────────────────────────────────────────────

/**
 * Exact row budgets for the enabled right-column sections: percentages are
 * converted with largest-remainder rounding so the column always fills the
 * terminal rows exactly; every section keeps a minimum (MIN_SECTION_ROWS),
 * stolen from the largest section when clamping bites.
 */
function rowBudgets(
	totalRows: number,
	pcts: number[],
): { rows: number[]; ok: boolean } {
	const n = pcts.length;
	if (n === 0) return { rows: [], ok: true };
	const minTotal = MIN_SECTION_ROWS * n;
	if (totalRows < minTotal) {
		// Too short for every panel: give each the minimum and let the column
		// overflow-clip (VStack shrink handles it); flag not-ok so callers can
		// hide the column instead when the terminal is truly tiny.
		return { rows: pcts.map(() => MIN_SECTION_ROWS), ok: false };
	}
	// Largest-remainder rounding to fill exactly totalRows.
	const exact = pcts.map((p) => (totalRows * p) / pcts.reduce((a, b) => a + b, 0));
	const rows = exact.map((v) => Math.floor(v));
	const rem = totalRows - rows.reduce((a, b) => a + b, 0);
	const order = exact
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac);
	for (let k = 0; k < rem; k++) rows[order[k % order.length].i]++;
	// Enforce minimums, stealing from the largest section.
	for (let i = 0; i < n; i++) {
		if (rows[i] < MIN_SECTION_ROWS) {
			const steal = MIN_SECTION_ROWS - rows[i];
			rows[i] += steal;
			let big = 0;
			for (let j = 1; j < n; j++) if (rows[j] > rows[big]) big = j;
			if (big === i) break;
			rows[big] -= steal;
		}
	}
	return { rows, ok: true };
}

/** Left/right column widths for the current terminal, honoring the 20–80
 * leftPct band and per-side minimums. The right column hides below
 * MIN_TERM_WIDTH (handled by the caller + visible callbacks). */
function columnWidths(cols: number): { leftW: number; rightW: number } {
	const usable = Math.max(1, cols - 1); // 1-col divider
	let leftW = Math.round((usable * leftWidthPct) / 100);
	let rightW = usable - leftW;
	if (rightW < MIN_SIDE_COLS) {
		rightW = MIN_SIDE_COLS;
		leftW = usable - rightW;
	}
	if (leftW < MIN_SIDE_COLS) {
		leftW = MIN_SIDE_COLS;
		rightW = usable - leftW;
	}
	return { leftW, rightW };
}

// ─── layout composition (one layer) ──────────────────────────────────────────

/**
 * Compose the split layout around `inner` (pi's base root, or the
 * response-only inner when trim mode is on):
 *
 *   HStack[ left(=inner, grow) , divider(1 col) , rightColumn(basis) ]
 *
 * The left subtree is wrapped in a MeasurementSafeVStack with grow:1 — a bare
 * entry defaults to grow:0 and a sentinel-measuring wrapper would collapse
 * to intrinsic height, blanking the left side (upstream entry-form caveat).
 */
function composeLayout(theme: Theme, inner: Component): Component {
	let root = inner;
	if (trimResponse) {
		const trimmed = buildResponseInner(theme, getBaseRoot());
		if (trimmed) root = trimmed;
	}
	// Sticky prompt bar: pinned above the transcript in the left column. The
	// bar returns [] while hidden, so its basis-auto entry takes no rows.
	if (stickyOn) {
		stickyBar = new StickyPromptBar(theme, stickySource);
		root = new MeasurementSafeVStack([
			{ component: stickyBar, basis: "auto", grow: 0, shrink: 0 },
			{ component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
	} else {
		stickyBar = null;
	}
	if (!rightColumnWanted()) return root;

	const cols = tuiRef?.terminal?.columns ?? 0;
	const rows = tuiRef?.terminal?.rows ?? 0;
	// NOTE: never short-circuit on cols < MIN_TERM_WIDTH by returning `root`
	// unchanged — the layer would then be a registered identity wrap, and
	// selfHealLayout (which re-applies when the live root equals the base
	// root) would re-apply + full-repaint EVERY frame, wedging the renderer.
	// Instead the divider and right column entries carry a visible() callback
	// that hides them below MIN_TERM_WIDTH; the left entry (grow) then takes
	// the full width, exactly like the retired upstream files dock.
	const { rightW } = columnWidths(cols);
	const visibleEnough = (v: { width: number }) => v.width >= MIN_TERM_WIDTH;

	// Right column sections in fixed order: thinking, tools, files.
	const pcts: number[] = [];
	const specs: {
		build: (sectionRows: number) => Component;
	}[] = [];
	if (thinkingOn) {
		pcts.push(thinkingPct);
		specs.push({
			build: (sectionRows) =>
				framedPanel(theme, {
					title: "Thinking",
					streaming: () => thinkingPanel.streaming(),
					lines: (w) => thinkingPanel.lines(theme, w),
					version: () => thinkingPanel.version(),
					empty: "Thinking idle",
					rows: () => sectionRows,
					style: (l) => theme.fg("thinkingText", l),
				}),
		});
	}
	if (toolsOn) {
		pcts.push(toolsPct);
		specs.push({
			build: (sectionRows) =>
				framedPanel(theme, {
					title: "Tools",
					streaming: () => toolsPanel.activeAny(),
					lines: (w) => toolsPanel.lines(theme, w),
					version: () => toolsPanel.version(),
					empty: "No tools called yet",
					rows: () => sectionRows,
				}),
		});
	}
	if (filesOn) {
		pcts.push(filesPct);
		specs.push({
			build: (sectionRows) =>
				createFilesPanel(theme, () => sectionRows, requestRender),
		});
	}
	const { rows: budgets, ok } = rowBudgets(rows, pcts);
	if (!ok) return root;

	const sections = specs.map((s, i) => ({
		component: s.build(budgets[i]),
		basis: budgets[i],
		grow: 0,
		shrink: 1,
		minSize: Math.min(MIN_SECTION_ROWS, budgets[i]),
	}));
	const rightColumn = new MeasurementSafeVStack(sections);

	const divider = new DragDivider({
		theme,
		termCols: () => tuiRef?.terminal?.columns ?? 0,
		termRows: () => tuiRef?.terminal?.rows ?? 0,
		getLeftPct: () => leftWidthPct,
		setLeftPct: (pct) => {
			leftWidthPct = pct;
		},
		onPctChange: () => reconcileLayout(currentTheme()),
	});

	const left = stickyOn
		? (root as Component) // already the MeasurementSafeVStack built above
		: new MeasurementSafeVStack([
				{ component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			]);
	return new HStack([
		{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: divider,
			basis: 1,
			grow: 0,
			shrink: 0,
			minSize: 1,
			visible: visibleEnough,
		},
		{
			component: rightColumn,
			basis: rightW,
			grow: 0,
			shrink: 0,
			minSize: rightW,
			visible: visibleEnough,
		},
	]);
}

/** Reconcile the single layout layer with the current flags. */
function reconcileLayout(theme: Theme): void {
	if (!anyFlagOn() || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
		if (isLayoutLayerActive(LAYER_ID)) setLayoutLayer(LAYER_ID, null);
		return;
	}
	setLayoutLayer(LAYER_ID, (inner: Component) => composeLayout(theme, inner));
	composedTheme = theme;
	composedThemeFp = themeFingerprint(theme);
	composedCols = tuiRef?.terminal?.columns ?? -1;
	composedRows = tuiRef?.terminal?.rows ?? -1;
}

/** Theme of the current composition, captured at reconcile time; the drag
 * divider's recompose callback needs it (pi swaps the theme object with no
 * event, so always the one the widget render loop saw last). */
let composedTheme: Theme | null = null;

function currentTheme(): Theme {
	return composedTheme as Theme;
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split layout panels",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("split-fake-updates", {
		description:
			"Test fixture: show fake update notices (no network, fake version/packages)",
		type: "boolean",
		default: false,
	});
	// The panel modules bump versions on coalesced timers; route their
	// repaint requests through our TUI handle.
	setPanelRenderHook(() => requestRender());

	const ensureWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				tuiRef = tui;
				initLayoutManager(tui);
				// Bash blocks need a TUI handle for their loader spinners.
				setResponseTui(tui);
				// Doc block dividers need the theme as early as the first rebuild
				// (the render loop refreshes it every frame after this).
				setResponseTheme((tuiRef?.theme ?? ctx.ui.theme) as Theme);
				// Apply the still-pending startup composition here: the widget
				// factory runs synchronously during session_start, before the
				// first paint, and the fullscreen root is available right now.
				if (startupPending && REG.gen === MY_GEN) {
					startupPending = false;
					reconcileLayout(tui?.theme ?? ctx.ui.theme);
				}
				return {
					render: (_width: number) => {
						selfHealLayout();
						const liveTheme = (tuiRef?.theme ?? ctx.ui.theme) as Theme;
						// The response doc's block dividers need the live theme.
						setResponseTheme(liveTheme);
						// Theme change: pi swaps the global theme object with no
						// event; components/caches capture ANSI at build time, so
						// compare a fingerprint and recompose ONLY on a change.
						const fp = themeFingerprint(liveTheme);
						if (composedThemeFp === null) composedThemeFp = fp;
						else if (fp !== composedThemeFp) {
							composedThemeFp = fp;
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// Resize: recompose whenever the terminal geometry moved
						// (widths/row budgets are captured at compose time).
						const cols = tuiRef?.terminal?.columns ?? 0;
						const rows = tuiRef?.terminal?.rows ?? 0;
						if (
							rightColumnWanted() &&
							((cols > 0 && cols !== composedCols) ||
								(rows > 0 && rows !== composedRows))
						) {
							reconcileLayout(liveTheme);
						}
						// Leaf diff: bang results, compactions, branch summaries,
						// custom messages land in the branch with NO extension
						// event — the O(1) getLeafId compare is the whole cost
						// when nothing moved.
						if (syncBranchEntries(ctx)) requestRender();
						// Status mirror: extension ui.notify output and pi's own
						// transient statuses are chat-container ThemedText lines,
						// invisible in response-only mode (the transcript stays
						// detached). Mirror new ones into the doc (split-status.ts).
						if (pollStatusLines()) requestRender();
						return [];
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	/** Rebuild panel buffers + the response doc from the current branch
	 * (start / reload / tree), in ONE ordered pass so panel rows keep branch
	 * order (a skill row stays above the tool calls that follow it). */
	const reconstruct = (ctx: ExtensionContext) => {
		thinkingPanel.reset();
		toolsPanel.reset();
		responseDocBegin();
		// ensureWidget FIRST: the widget factory sets tuiRef synchronously, and
		// bash blocks rebuilt from the branch need it for their loaders.
		ensureWidget(ctx);
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "message") {
				const msg = (entry as any).message;
				if (!msg) continue;
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const c of msg.content) {
						try {
							if (c?.type === "thinking" && typeof c.thinking === "string") {
								// Rebuild bounded thinking blocks through the same
								// ingest path live events use (upstream SV-17).
								thinkingPanel.start();
								thinkingPanel.end(c.thinking);
							}
							if (c?.type === "toolCall" && c.name) {
								if (typeof c.id === "string")
									toolsPanel.ingestCall(c.id, c.name, c.arguments ?? {});
							}
						} catch {
							/* skip */
						}
					}
				}
				// Rebuild tool outputs from persisted results, correlated by id.
				if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
					try {
						toolsPanel.ingestResult(msg.toolCallId, msg.content, msg.isError);
					} catch {
						/* skip */
					}
				}
			}
			// Doc + session-event rows (bash blocks, skills, compaction, branch
			// summaries, custom display messages), same path the live walk uses.
			responseIngestEntry(entry);
		}
		responseDocEnd(ctx);
		// Update notices are session-lifetime, NOT branch entries: the branch
		// walk does not re-ingest them, so re-ingest the panel rows here (the
		// doc blocks were just re-appended by responseDocEnd). Stable ids
		// dedupe against any live rows from the deferred check.
		for (const n of getActiveNotices()) {
			toolsPanel.ingestEvent(n.id, n.title, noticeBodyText(n));
		}
		if (anyPanelActive()) requestRender();
	};

	const applyConfigFlags = (cfg: NormalizedSplitConfig) => {
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		filesOn = cfg.files;
		trimResponse = cfg.trimResponse;
		stickyOn = cfg.sticky;
		toolMode = cfg.toolMode;
		leftWidthPct = cfg.leftWidthPct;
		thinkingPct = cfg.thinkingPct;
		toolsPct = cfg.toolsPct;
		filesPct = cfg.filesPct;
		toolsPanel.setMode(cfg.toolMode);
		// The filechanges above-editor widget hides while our panel owns files.
		setFilesSuppressed(filesOn);
	};

	pi.on("session_start", (_e, ctx) => {
		let cfg = normalizeConfig(loadSplitConfig());
		if (pi.getFlag("no-split")) {
			cfg = { ...cfg, split: false, thinking: false, tools: false, files: false, trimResponse: false, sticky: false };
		}
		// Bind the files panel to the session's shared tracker first: the
		// suppression decision below needs it. Creates it if filechanges.ts
		// has not loaded yet (exactly-once event wiring lives in the tracker).
		initFilesPanel(pi, ctx);
		// Status mirror wiring (split-status.ts): the chat container is read
		// through the base root, and mirroring runs only while response-only
		// mode owns the left column.
		initStatusMirror(() => getBaseRoot(), () => trimResponse);
		applyConfigFlags(cfg);
		// Arm the startup composition BEFORE reconstruct — the widget factory
		// runs synchronously inside it (first point where the root exists).
		startupPending = ctx.mode === "tui";
		reconstruct(ctx);
		if (ctx.mode === "tui") {
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = setTimeout(() => {
				startupTimer = null;
				if (REG.gen !== MY_GEN) return;
				try {
					if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
						if (startupPending) {
							startupPending = false;
							reconcileLayout(ctx.ui.theme);
						}
						if (rightColumnWanted() || trimResponse || stickyOn)
							ctx.ui.notify("Split view on", "info");
					}
				} catch {
					/* never crash pi from a deferred callback */
				}
			}, 0);
		}
		// Update notices (split-updates.ts): reset session state, then run the
		// checks deferred (~1.5s, matching pi's async startup checks — session
		// start ONLY, never /reload). Results land as Tools panel event rows
		// and doc blocks; --split-fake-updates forces fixtures for tests.
		resetUpdateNotices();
		if (ctx.mode === "tui") scheduleUpdateChecks(pi, ctx);
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	/** Deferred startup update checks. Never blocks startup, swallows every
	 * error, and no-ops after a /reload (generation guard). */
	const scheduleUpdateChecks = (pi: ExtensionAPI, ctx: ExtensionContext) => {
		if (updateCheckTimer) clearTimeout(updateCheckTimer);
		updateCheckTimer = setTimeout(() => {
			updateCheckTimer = null;
			if (REG.gen !== MY_GEN) return;
			void (async () => {
				try {
					const notices = pi.getFlag("split-fake-updates")
						? fakeUpdateNotices()
						: await collectStartupNotices(ctx);
					if (notices.length === 0) return;
					setUpdateNotices(notices);
					// Tools panel rows (stable ids dedupe across reconstruct's re-ingest).
					for (const n of notices) {
						toolsPanel.ingestEvent(n.id, n.title, noticeBodyText(n));
					}
					// Response doc blocks (response-only mode): re-append idempotently.
					appendUpdateNoticesToDoc();
					// Persistent footer status: the one surface visible in EVERY layout
					// state (response-only + right column hidden + long resumed doc puts
					// the doc-top block above the fold and leaves no panel row).
					const status = noticesStatusText(notices);
					if (status) {
						try {
							ctx.ui.setStatus("split-updates", status);
						} catch {
							/* ignore */
						}
					}
					requestRender();
				} catch {
					/* never crash the TUI from a deferred callback */
				}
			})();
		}, 1500);
	};

	// A `!`/`!!` bang command started. pi emits user_bash BEFORE executing and
	// aborts the command if any handler throws, and takes over execution if a
	// handler returns a result — so this handler must never throw and must
	// always return undefined. It only drops a running block into the response
	// doc; the per-frame leaf walk completes it from the appended branch entry.
	pi.on("user_bash", (event) => {
		try {
			const e = event as { command?: string; excludeFromContext?: boolean };
			startLiveBash(String(e?.command ?? ""), !!e?.excludeFromContext);
			requestRender();
		} catch {
			/* never break bang execution */
		}
		return undefined;
	});

	// Thinking stream + response doc streaming.
	pi.on("message_update", (event) => {
		const d = (event as any).assistantMessageEvent;
		if (d) {
			if (d.type === "thinking_start") thinkingPanel.start();
			else if (d.type === "thinking_delta") thinkingPanel.append(d.delta ?? "");
			else if (d.type === "thinking_end") thinkingPanel.end(d.content ?? "");
		}
		responseMessageUpdate((event as any).message);
		if (anyPanelActive()) requestRender();
	});
	// Response doc: user messages on start, assistant finalize on end. The doc
	// is always maintained so toggling trim mid-turn is seamless.
	pi.on("message_start", (event) => {
		responseMessageStart((event as any).message);
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		responseMessageEnd((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Tool stream (same ingest path the branch rebuild uses).
	pi.on("tool_execution_start", (event) => {
		toolsPanel.ingestCall(event.toolCallId, event.toolName, event.args);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_update", (event) => {
		toolsPanel.ingestUpdate(event.toolCallId, (event as any).partialResult);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_end", (event) => {
		toolsPanel.ingestResult(event.toolCallId, (event as any).result, event.isError);
		if (anyPanelActive()) requestRender();
	});

	// Subagent tool calls: badge entry in the tools panel.
	pi.events.on("subagents:tool_call", (data) => {
		const { toolName, input, agent } = (data ?? {}) as {
			toolName?: string;
			input?: unknown;
			agent?: string;
		};
		if (!toolName) return;
		try {
			toolsPanel.ingestSubagent(toolName, input ?? {}, agent);
			if (anyPanelActive()) requestRender();
		} catch {
			/* never break the listener */
		}
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = null;
		}
		if (updateCheckTimer) {
			clearTimeout(updateCheckTimer);
			updateCheckTimer = null;
		}
		resetUpdateNotices();
		try {
			ctx.ui.setStatus("split-updates", undefined);
		} catch {
			/* ignore */
		}
		setLayoutLayer(LAYER_ID, null);
		resetLayoutManager();
		stickyBar?.dispose();
		stickyBar = null;
		resetResponseState();
		resetStatusMirror();
		setFilesSuppressed(false);
		disposeFilesPanel();
		setPanelRenderHook(null);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetSet = false;
	});

	// ── guards ──

	const requireFullscreen = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Interactive mode required", "error");
			return false;
		}
		if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
			ctx.ui.notify(
				"Fullscreen mode required (tuiMode: fullscreen in settings)",
				"warning",
			);
			return false;
		}
		return true;
	};

	// ── panel toggles ──

	pi.registerCommand("split-toggle", {
		description:
			"Toggle the split layout: off = bare pi layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			const wasOn = anyFlagOn();
			if (wasOn) {
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				trimResponse = false;
				stickyOn = false;
				setFilesSuppressed(false);
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split off (bare layout)", "info");
			} else {
				const cfg = normalizeConfig(loadSplitConfig());
				if (!cfg.thinking && !cfg.tools && !cfg.files && !cfg.trimResponse) {
					// Nothing saved: default layout = all three right panels + sticky.
					thinkingOn = true;
					toolsOn = true;
					filesOn = true;
					stickyOn = true;
				} else {
					thinkingOn = cfg.thinking;
					toolsOn = cfg.tools;
					filesOn = cfg.files;
					trimResponse = cfg.trimResponse;
					stickyOn = cfg.sticky;
				}
				setFilesSuppressed(filesOn);
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split on (saved layout)", "info");
			}
		},
	});

	pi.registerCommand("split-toggle-sticky", {
		description:
			"Sticky user prompt pinned at the top of the left column: toggle, or on|off",
		handler: async (args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !stickyOn;
			if (next === stickyOn) {
				ctx.ui.notify(`Sticky prompt ${stickyOn ? "on" : "off"}`, "info");
				return;
			}
			stickyOn = next;
			reconcileLayout(ctx.ui.theme);
			// Sticky was the last flag on and it just went off: whole layout is bare.
			if (!anyFlagOn()) {
				ctx.ui.notify("Split off (bare layout)", "info");
				return;
			}
			ctx.ui.notify(`Sticky prompt ${stickyOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-toggle-thinking", {
		description: "Toggle the thinking panel in the right column",
		handler: async (_args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			thinkingOn = !thinkingOn;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Thinking ${thinkingOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-toggle-tools", {
		description: "Toggle the tool usage panel in the right column",
		handler: async (_args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			toolsOn = !toolsOn;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools ${toolsOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-toggle-files", {
		description: "Toggle the file changes panel in the right column",
		handler: async (_args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			filesOn = !filesOn;
			setFilesSuppressed(filesOn);
			reconcileLayout(ctx.ui.theme);
			const cols = tuiRef?.terminal?.columns ?? 0;
			if (filesOn && cols > 0 && cols < MIN_TERM_WIDTH) {
				ctx.ui.notify(
					`File changes panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${cols})`,
					"warning",
				);
			} else {
				ctx.ui.notify(`File changes ${filesOn ? "on" : "off"}`, "info");
			}
		},
	});

	pi.registerCommand("split-toggle-right", {
		description:
			"Toggle the whole right column: toggle, or on|off; hiding keeps the panel set for re-show",
		handler: async (args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			const shown = rightColumnWanted();
			const next = arg === "on" ? true : arg === "off" ? false : !shown;
			if (next === shown) {
				ctx.ui.notify(`Right column ${shown ? "on" : "off"}`, "info");
				return;
			}
			if (!next) {
				// Hide: snapshot the live panel set so the re-show restores it
				// exactly (per-panel toggles while hidden reshape the live view
				// only, never the snapshot).
				rightHiddenSnapshot = {
					thinking: thinkingOn,
					tools: toolsOn,
					files: filesOn,
				};
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				// Keep the above-editor filechanges widget suppressed when the
				// files panel was part of the hidden set: hiding the right column
				// must yield a CLEAN conversation, not resurrect the widget with
				// the last round's changes (the tracker keeps running either way;
				// if files was already off, the widget stays as it was).
				setFilesSuppressed(rightHiddenSnapshot.files);
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Right column off", "info");
				return;
			}
			if (rightHiddenSnapshot) {
				// Re-show: restore the snapshot (it always has ≥1 panel on, since
				// it was taken while the column was visible).
				thinkingOn = rightHiddenSnapshot.thinking;
				toolsOn = rightHiddenSnapshot.tools;
				filesOn = rightHiddenSnapshot.files;
				rightHiddenSnapshot = null;
			} else {
				// First show this session: saved startup defaults, or all three
				// panels when nothing is saved (same policy as /split-toggle's on path).
				const cfg = normalizeConfig(loadSplitConfig());
				thinkingOn = cfg.thinking;
				toolsOn = cfg.tools;
				filesOn = cfg.files;
				if (!rightColumnWanted()) {
					thinkingOn = true;
					toolsOn = true;
					filesOn = true;
				}
			}
			setFilesSuppressed(filesOn);
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify("Right column on", "info");
		},
	});

	pi.registerCommand("split-toggle-tools-detail", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolsPanel.setMode(toolMode);
			ctx.ui.notify(`Tool panel: ${toolMode}`, "info");
			requestRender();
		},
	});

	pi.registerCommand("split-width", {
		description:
			"Left column width as % of usable width (20-80, default 60); also draggable",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			if (!arg) {
				ctx.ui.notify(
					`Left column: ${leftWidthPct}% (usage: /split-width 20-80, or drag the divider)`,
					"info",
				);
				return;
			}
			const n = Number.parseInt(arg, 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify("Invalid percentage (usage: /split-width 20-80)", "error");
				return;
			}
			leftWidthPct = Math.max(20, Math.min(80, n));
			if (!requireFullscreen(ctx)) return;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Left column: ${leftWidthPct}%`, "info");
		},
	});

	/** Shared handler for the three right-panel row-share commands. */
	const setRightPct = (
		which: "thinking" | "tools" | "files",
		args: string | undefined,
		ctx: ExtensionContext,
	) => {
		const label =
			which === "thinking" ? "Thinking" : which === "tools" ? "Tools" : "File Changes";
		const arg = String(args ?? "").trim();
		const current = which === "thinking" ? thinkingPct : which === "tools" ? toolsPct : filesPct;
		if (!arg) {
			ctx.ui.notify(`${label} rows: ${current}% of the right column (usage: 10-70)`, "info");
			return;
		}
		const n = Number.parseInt(arg, 10);
		if (Number.isNaN(n)) {
			ctx.ui.notify(`Invalid percentage (usage: /split-${which}-height 10-70)`, "error");
			return;
		}
		const pcts = normalizeRightPcts(
			which === "thinking" ? n : thinkingPct,
			which === "tools" ? n : toolsPct,
			which === "files" ? n : filesPct,
		);
		thinkingPct = pcts.thinkingPct;
		toolsPct = pcts.toolsPct;
		filesPct = pcts.filesPct;
		if (!requireFullscreen(ctx)) return;
		reconcileLayout(ctx.ui.theme);
		ctx.ui.notify(
			`Right rows: thinking ${thinkingPct}% · tools ${toolsPct}% · files ${filesPct}%`,
			"info",
		);
	};

	pi.registerCommand("split-thinking-height", {
		description: "Thinking panel's share of the right column rows in % (10-70)",
		handler: async (args, ctx) => setRightPct("thinking", args, ctx),
	});
	pi.registerCommand("split-tools-height", {
		description: "Tools panel's share of the right column rows in % (10-70)",
		handler: async (args, ctx) => setRightPct("tools", args, ctx),
	});
	pi.registerCommand("split-files-height", {
		description: "File changes panel's share of the right column rows in % (10-70)",
		handler: async (args, ctx) => setRightPct("files", args, ctx),
	});

	pi.registerCommand("split-toggle-response-only", {
		description:
			"Left column: full transcript ↔ response-only (text-only, full scrollback, offset preserved)",
		handler: async (args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !trimResponse;
			if (next) {
				const base = getBaseRoot();
				if (!base) {
					ctx.ui.notify("Layout root not ready yet", "warning");
					return;
				}
				// Fail loudly if the input dock cannot be extracted (upstream SV-22):
				// silently claiming response-only while the native transcript
				// stays would be a lie.
				if (!baseDockOf(base)) {
					ctx.ui.notify(
						"Response-only unavailable: input dock not found in the layout root",
						"error",
					);
					return;
				}
			}
			trimResponse = next;
			try {
				reconcileLayout(ctx.ui.theme);
			} catch (err) {
				// Roll back and surface the real error: a half-composed layout
				// with a wrong flag would be worse than a clean failure.
				trimResponse = !next;
				try {
					reconcileLayout(ctx.ui.theme);
				} catch {
					/* ignore */
				}
				ctx.ui.notify(`Response-only failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			ctx.ui.notify(
				`Left column: ${trimResponse ? "response only" : "full transcript"}`,
				"info",
			);
			// The notify lands in the native transcript, which is not rendered
			// while response-only is ON — so also show a transient status hint,
			// which is visible in both views (upstream had the same blind spot).
			// Cancel any prior clear timer first: rapid toggles would otherwise
			// let the OLD timer wipe the NEWER hint early (4s from ITS toggle).
			try {
				ctx.ui.setStatus("split", trimResponse ? "left: response only" : "left: full transcript");
				if (trimHintTimer) clearTimeout(trimHintTimer);
				trimHintTimer = setTimeout(() => {
					trimHintTimer = null;
					try {
						ctx.ui.setStatus("split", undefined);
					} catch {
						/* ignore */
					}
				}, 4000);
			} catch {
				/* ignore */
			}
		},
	});

	pi.registerCommand("split-changelog", {
		description:
			"Append the running version's full changelog entry to the response view (pi's /changelog output is transcript-only)",
		handler: async (_args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			// pi's own /changelog prints into the native transcript, which is not
			// rendered while response-only is ON — the exact information-loss
			// class this extension exists to close. With response-only OFF the
			// native command already works, so just point at it.
			if (!trimResponse) {
				ctx.ui.notify(
					"Response-only view is off: use pi's own /changelog, it prints into the transcript",
					"info",
				);
				return;
			}
			const entry = readCurrentVersionEntry();
			if (!entry) {
				ctx.ui.notify(`Changelog entry not found. Full changelog: ${CHANGELOG_URL}`, "info");
				return;
			}
			// Replace any previous on-demand block (id prefix dedupe); the doc
			// follows its end, so the atEnd block is visible immediately.
			setUpdateNotices([
				...getActiveNotices().filter((n) => !n.id.startsWith(ONDEMAND_CHANGELOG_PREFIX)),
				buildOndemandChangelogNotice(VERSION, entry),
			]);
			appendUpdateNoticesToDoc();
			requestRender();
		},
	});

	pi.registerCommand("split-save", {
		description: "Save current layout as the startup defaults for new windows",
		handler: async (_args, ctx) => {
			// Report the real outcome — success only after a durable write.
			const saved = saveSplitConfig({
				split: anyFlagOn(),
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesOn,
				toolMode,
				trimResponse,
				sticky: stickyOn,
				leftWidthPct,
				thinkingPct,
				toolsPct,
				filesPct,
			});
			ctx.ui.notify(
				saved
					? "Split layout saved as startup defaults for new windows"
					: "Could not save split layout (config write failed)",
				saved ? "success" : "error",
			);
		},
	});
}
