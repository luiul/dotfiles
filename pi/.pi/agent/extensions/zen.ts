/**
 * zen.ts — the transcript filter for bare pi.
 *
 *   ┌ transcript ─────────────────────────────────────────┐
 *   │ ▸ user prompt                                       │
 *   │   Thinking...                        ← dim, native   │
 *   │ ▸ assistant text                                     │
 *   │   (tool calls: hidden while filtered, except errors) │
 *   └─────────────────────────────────────────────────────┘
 *
 * One toggle (`/zen [on|off]`, `ctrl+alt+t`) hides the noise in bare
 * pi's transcript: successful tool calls vanish completely, thinking
 * collapses to pi's own dim "Thinking..." label (click to expand), and
 * FAILED tool calls stay visible because errors are signal, not noise.
 * Toggling off restores the byte-exact native transcript: zen never
 * replaces pi's renderers, it flips the same visibility fields pi's own
 * toggles use:
 * - AssistantMessageComponent.setHideThinkingBlock (what ctrl+t uses).
 * - ToolExecutionComponent.hideComponent (pi's renderer returns zero rows
 *   for a component with hideComponent set; render() drops the block).
 *
 * Overhead is near zero by construction: no layout change (the transcript
 * keeps full width, so pi keeps its painter fast path), no per-frame work
 * (the widget only captures the TUI handle and renders []), and hidden
 * rows never paint, so noisy turns cost LESS than bare pi (measured,
 * issue #67). The event walks are O(components) but idempotent and mostly
 * no-ops; steady state during streaming is zero walks per delta.
 *
 * Mechanics that force the event wiring (verified 2026-10-26):
 * - pi's updateDisplay resets hideComponent=false on EVERY tool update,
 *   so zen re-applies on tool_execution_start/update/end.
 * - Branch switches, compaction, /reload, and session resume rebuild the
 *   transcript with fresh components, so zen re-applies on session_tree,
 *   compaction, and session_start.
 * - New assistant components are constructed with the app's hideThinking
 *   flag from settings, not zen's flag, so zen re-applies on
 *   message_start/message_update until the new component is marked.
 *
 * Failure policy: fail-open. Every internals reach-in is duck-typed and
 * wrapped; if a pi upgrade changes the component shapes, filtering stops
 * working (content stays visible) but never crashes pi. The E2E
 * (scripts/test-zen-extension.sh) trips loudly on such drift.
 *
 * Scope: fullscreen TUI only (tuiMode: fullscreen). In regular and
 * non-interactive modes the extension stays dormant and /zen says so.
 * Transcript search cannot find rows hidden while filtered; toggle off to
 * inspect. Native ctrl+t (thinking only) keeps working.
 *
 * Replaces the split extension's response-only mode as the daily driver;
 * see the zen toggle issue (luiul/dotfiles#67) for decisions and history.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── config ──────────────────────────────────────────────────────────────────

let CONFIG_PATH = path.join(homedir(), ".pi", "agent", "zen.json");

/** Test seam (repo convention): point the config file at a temp path. */
export function __setConfigPathForTest(p: string): void {
	CONFIG_PATH = p;
}

/**
 * Filter state for new sessions. Strict typing: only a real boolean counts,
 * so bad JSON can never flip the filter on or off accidentally. Defaults
 * to ON: a new pi window starts zen (user decision, issue #67).
 */
export function loadFilterOn(): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			const filter = (raw as { filter?: unknown }).filter;
			if (typeof filter === "boolean") return filter;
		}
	} catch {
		/* missing or bad file: default below */
	}
	return true;
}

/** Persist the toggle. Returns whether the write actually succeeded. */
export function saveFilterOn(on: boolean): boolean {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify({ filter: on }, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}

// ─── transcript walk ─────────────────────────────────────────────────────────

/**
 * The message subtree to walk: the first child-holding entry of the
 * fullscreen layout root is the transcript ScrollView; its child is the
 * container subtree that holds the message components. Returns null when
 * the tree does not match (regular mode, not ready, drifted internals).
 */
function chatRoot(tui: unknown): unknown {
	const entries = (tui as any)?.layoutRoot?.entries;
	if (!Array.isArray(entries)) return null;
	for (const e of entries) {
		const c = e?.component;
		if (c && Object.hasOwn(c, "child")) return c.child;
	}
	return null;
}

/**
 * Visit every node of the transcript subtree once. Recursive with a seen
 * set (cycle guard). The visitor is wrapped per node: one throwing node
 * (or visitor) never aborts the walk. Exported for unit tests.
 */
export function walkTranscript(tui: unknown, fn: (node: any) => void): void {
	const seen = new Set<object>();
	const dive = (node: any): void => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		try {
			fn(node);
		} catch {
			/* one bad node never aborts the walk */
		}
		for (const k of node?.children ?? []) dive(k);
	};
	try {
		dive(chatRoot(tui));
	} catch {
		/* tree not ready: nothing to do */
	}
}

// ─── component duck types + decisions ────────────────────────────────────────

/** An AssistantMessageComponent (renders thinking blocks). */
const isAssistant = (k: any) => typeof k?.setHideThinkingBlock === "function";
/** A ToolExecutionComponent (renders one tool call). */
const isTool = (k: any) => typeof k?.toolCallId === "string" && "hideComponent" in k;
/** A tool component whose final result failed: never hidden while filtered. */
const toolFailed = (k: any) => !!(k as any)?.result?.isError;

/**
 * Whether a tool component should be hidden right now. Exported for unit
 * tests: the error rule (failed calls stay visible) is the policy core.
 */
export function shouldHideTool(k: any, filterOn: boolean): boolean {
	return filterOn && isTool(k) && !toolFailed(k);
}

// ─── module state (single-session-per-process, like the split) ───────────────

// Generation guard: survives /reload, lets stale deferred walks no-op.
const REG_KEY = Symbol.for("pi.zen");
const G = globalThis as Record<symbol, { gen: number }>;
const REG = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

let tuiRef: any;
let filterOn = true;
let widgetSet = false;
/** Assistant components already marked hidden this stream (WeakSet: the
 * setHideThinkingBlock call clears per-block expand overrides, so it must
 * not repeat once applied). */
const hiddenThinking = new WeakSet<object>();
/**
 * True while the current assistant message's component has not been
 * marked yet: message_update walks stop once it is, so steady state
 * during streaming is zero walks per delta.
 */
let pendingAssistant = false;

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

// ─── apply passes ────────────────────────────────────────────────────────────

/**
 * Apply the filter state to every component in the transcript. Used on
 * toggle, session start, and container rebuilds (branch switch,
 * compaction, /reload): cheap, unconditional, and correct from any state.
 *
 * Order matters on tool components: invalidate() FIRST, then set
 * hideComponent, because pi's updateDisplay (reached through invalidate)
 * resets hideComponent=false on entry.
 */
function applyAll(): void {
	let touched = false;
	walkTranscript(tuiRef, (k) => {
		if (isAssistant(k)) {
			try {
				k.setHideThinkingBlock(filterOn);
				if (filterOn) hiddenThinking.add(k);
				touched = true;
			} catch {
				/* skip */
			}
		} else if (isTool(k)) {
			const hide = shouldHideTool(k, filterOn);
			if (k.hideComponent !== hide) {
				try {
					k.invalidate();
				} catch {
					/* skip */
				}
				k.hideComponent = hide;
				touched = true;
			}
		}
	});
	if (touched) requestRender();
}

/**
 * Apply to components that are new or were reset since the last pass.
 * Idempotent: already-correct components are skipped, so the walk costs
 * only the tree traversal. No-op while the filter is off (bare pi look).
 */
function applyNew(): void {
	if (!filterOn) return;
	let touched = false;
	walkTranscript(tuiRef, (k) => {
		if (isTool(k) && !toolFailed(k) && k.hideComponent !== true) {
			try {
				k.invalidate();
			} catch {
				/* skip */
			}
			k.hideComponent = true;
			touched = true;
		} else if (isAssistant(k) && !hiddenThinking.has(k) && k.hideThinkingBlock !== true) {
			hiddenThinking.add(k);
			try {
				k.setHideThinkingBlock(true);
			} catch {
				/* skip */
			}
			if (k.hideThinkingBlock !== true) hiddenThinking.delete(k);
			touched = true;
			pendingAssistant = false;
		}
	});
	if (touched) requestRender();
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-zen", {
		description: "Start with the transcript filter off, regardless of the saved default",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("zen", {
		description: "Start with the transcript filter on, regardless of the saved default",
		type: "boolean",
		default: false,
	});

	const requireFullscreen = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui" || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
			ctx.ui.notify(
				"Interactive fullscreen mode required (tuiMode: fullscreen in settings)",
				"warning",
			);
			return false;
		}
		return true;
	};

	const toggle = (on: boolean, ctx: ExtensionContext): void => {
		filterOn = on;
		const saved = saveFilterOn(on);
		applyAll();
		ctx.ui.notify(
			`zen: ${on ? "on" : "off"}` +
				(on ? " (tool calls hidden, thinking collapsed)" : " (full transcript)") +
				(saved ? "" : " — could not save, session only"),
			"info",
		);
	};

	pi.registerCommand("zen", {
		description: "Toggle the transcript filter: on hides tool calls (not errors) and collapses thinking",
		handler: async (args, ctx) => {
			if (!requireFullscreen(ctx)) return;
			const arg = String(args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !filterOn;
			if (next === filterOn) {
				ctx.ui.notify(`zen: already ${filterOn ? "on" : "off"}`, "info");
				return;
			}
			toggle(next, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+t", {
		description: "Toggle the transcript filter (zen)",
		handler: async (ctx) => {
			toggle(!filterOn, ctx);
		},
	});

	// Widget: exists only to capture the TUI handle (belowEditor, zero
	// rendered rows, no per-frame work). The factory runs synchronously
	// during session_start, before the first paint.
	const ensureWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		ctx.ui.setWidget(
			"zen",
			(tui) => {
				tuiRef = tui;
				// First point where the fullscreen root exists: apply the
				// startup filter state before the first paint.
				if (REG.gen === MY_GEN) applyAll();
				return { render: (_width: number) => [] };
			},
			{ placement: "belowEditor" },
		);
	};

	pi.on("session_start", (_e, ctx) => {
		// Explicit flags win over the saved default; neither persists it.
		filterOn = pi.getFlag("zen")
			? true
			: pi.getFlag("no-zen")
				? false
				: loadFilterOn();
		ensureWidget(ctx);
		// Rebuilds after /reload land here too: re-apply from scratch.
		if (ctx.mode === "tui") {
			applyAll();
			// Fallback for a factory that ran before the history components
			// existed (generation-guarded, so a /reload'd module no-ops).
			setTimeout(() => {
				if (REG.gen === MY_GEN && filterOn) applyNew();
			}, 0);
		}
	});

	// Container rebuilds: fresh components carry the settings defaults,
	// not zen's state, so re-apply unconditionally.
	pi.on("session_tree", () => applyAll());
	pi.on("compaction", () => applyAll());

	// Live streaming: mark each assistant component once (the app builds
	// it with the settings flag, which may disagree with zen's).
	pi.on("message_start", () => {
		pendingAssistant = true;
		applyNew();
	});
	pi.on("message_update", () => {
		if (pendingAssistant) applyNew();
	});
	pi.on("message_end", () => {
		pendingAssistant = false;
		applyNew();
	});

	// Live tool calls: pi's updateDisplay resets hideComponent on every
	// update, so re-apply on each tool event (sync + next tick, catching
	// components created after the event dispatch).
	const toolEvent = () => {
		applyNew();
		setTimeout(() => {
			if (REG.gen === MY_GEN) applyNew();
		}, 0);
	};
	pi.on("tool_execution_start", toolEvent);
	pi.on("tool_execution_update", toolEvent);
	pi.on("tool_execution_end", toolEvent);

	pi.on("session_shutdown", (_e, ctx) => {
		pendingAssistant = false;
		try {
			ctx.ui.setWidget("zen", undefined);
		} catch {
			/* ignore */
		}
		widgetSet = false;
		tuiRef = undefined;
	});
}
